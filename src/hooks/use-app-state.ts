import { useCallback, useEffect, useRef, useState } from 'react'
import { applyRuntimeEvent, createInitialState, mergeRecoveredEvents, recoverInterruptedState } from '@/lib/domain'
import { loadState, loadTaskHistory, loadTraceEvents, onRuntimeEvent, saveState } from '@/lib/bridge'
import { migrateWorkspace, reconcileSteps } from '@/lib/workspace'
import type { AppState, RuntimeEvent, Task } from '@/lib/types'
import { completionNotifications } from '@/lib/completion-notifications'
import { sendNativeNotification } from '@/lib/native-notifications'

interface Waiter { revision: number; resolve: () => void; reject: (error: unknown) => void }
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(true)
  const current = useRef<AppState | null>(null)
  const ready = useRef(false)
  const pending = useRef<{ state: AppState; revision: number } | null>(null)
  const waiters = useRef<Waiter[]>([])
  const writing = useRef(false)
  const revision = useRef(0)
  const hydration = useRef(new Map<string, Promise<Task>>())
  const buffered = useRef(new Map<string, RuntimeEvent[]>())
  const lifecycle = useRef<AbortController | null>(null)
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({})
  // One in-flight write and one latest snapshot: streaming never queues thousands
  // of growing state objects. Callers still await the revision they submitted.
  const persist = useCallback((next: AppState) => {
    const version = ++revision.current
    pending.current = { state: next, revision: version }
    setSaved(false)
    const result = new Promise<void>((resolve, reject) => waiters.current.push({ revision: version, resolve, reject }))
    if (!writing.current) {
      writing.current = true
      void (async () => {
        while (pending.current) {
          const job = pending.current
          pending.current = null
          try {
            await saveState(job.state)
            const done = waiters.current.filter(w => w.revision <= job.revision)
            waiters.current = waiters.current.filter(w => w.revision > job.revision)
            done.forEach(w => w.resolve())
            if (revision.current === job.revision) setSaved(true)
          } catch (e) {
            const failed = waiters.current.filter(w => w.revision <= job.revision)
            waiters.current = waiters.current.filter(w => w.revision > job.revision)
            failed.forEach(w => w.reject(e))
            setError(`保存失败：${String(e)}`)
          }
        }
        writing.current = false
      })()
    }
    return result
  }, [])
  const update = useCallback((fn: (state: AppState) => AppState) => {
    if (!current.current) return Promise.reject(new Error('应用尚未加载'))
    let next: AppState
    try { next = fn(current.current) } catch (e) { return Promise.reject(e) }
    if (next === current.current) return Promise.resolve()
    const notifications = completionNotifications(current.current, next)
    current.current = next
    if (ready.current) setState(next)
    return persist(next).then(() => {
      // Only a committed transition can announce completion. OS permission or
      // delivery errors must not reject the saved operation or delay a new run.
      for (const notification of notifications) {
        void sendNativeNotification(notification).catch(error => console.warn('原生通知发送失败：', error))
      }
    })
  }, [persist])

  const ensureTaskReady = useCallback((taskId: string): Promise<Task> => {
    const existing = hydration.current.get(taskId)
    if (existing) return existing
    const task = current.current?.tasks.find(task => task.id === taskId)
    if (!task) return Promise.reject(new Error('任务已不存在'))
    if (!task.historyPending) return Promise.resolve(task)
    const signal = lifecycle.current?.signal
    setHistoryErrors(errors => { const next = { ...errors }; delete next[taskId]; return next })
    const job = (async () => {
      try {
        const events = await loadTaskHistory(taskId, signal)
        signal?.throwIfAborted()
        const snapshot = current.current!
        const latest = snapshot.tasks.find(task => task.id === taskId)
        if (!latest) throw new Error('任务已不存在')
        const historyTask = { ...latest, events }
        const tail = await loadTraceEvents({ ...snapshot, tasks: [historyTask] })
        signal?.throwIfAborted()
        // Merge into the current metadata, preserving edits made while loading.
        // Live events were buffered so an incomplete protocol prefix could not
        // overwrite already-saved chat messages.
        await update(state => {
          const target = state.tasks.find(task => task.id === taskId)
          if (!target) throw new Error('任务已不存在')
          const base = { ...state, tasks: [{ ...target, events, historyPending: undefined }] }
          const merged = mergeRecoveredEvents(base, [...tail, ...(buffered.current.get(taskId) ?? [])])
          const recovered = recoverInterruptedState(merged).tasks[0]
          buffered.current.delete(taskId)
          return { ...state, tasks: state.tasks.map(task => task.id === taskId ? reconcileSteps(recovered) : task) }
        })
        signal?.throwIfAborted()
        return current.current!.tasks.find(task => task.id === taskId) ?? Promise.reject(new Error('任务已不存在'))
      } catch (error) {
        if (!signal?.aborted) setHistoryErrors(errors => ({ ...errors, [taskId]: String(error) }))
        throw error
      } finally { if (!signal?.aborted) hydration.current.delete(taskId) }
    })()
    hydration.current.set(taskId, job)
    return job
  }, [update])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    lifecycle.current = controller
    let unlisten: (() => void) | undefined
    const release = () => { const cleanup = unlisten; unlisten = undefined; cleanup?.() }
    void (async () => {
      try {
        const data = await loadState()
        if (disposed) return
        let initial = data ? migrateWorkspace(data) : createInitialState()
        const deferredHistory = Boolean(data?.tasks.some(task => task.historyPending))
        if (data && !deferredHistory) {
          const events = await loadTraceEvents(data)
          if (disposed) return
          initial = mergeRecoveredEvents(initial, events)
          initial = recoverInterruptedState(initial)
          const tasks = initial.tasks.map(reconcileSteps)
          if (tasks.some((task, index) => task !== initial.tasks[index])) initial = { ...initial, tasks }
        }
        current.current = initial
        unlisten = await onRuntimeEvent(event => {
          if (disposed) return
          if (current.current?.tasks.find(task => task.id === event.taskId)?.historyPending) {
            const pending = buffered.current.get(event.taskId) ?? []
            pending.push(event); buffered.current.set(event.taskId, pending)
            void ensureTaskReady(event.taskId).catch(() => {})
          } else void update(s => { const next = applyRuntimeEvent(s, event); return next === s ? s : { ...next, tasks: next.tasks.map(reconcileSteps) } }).catch(() => {})
        })
        if (disposed) { release(); return }
        // A clean reopen has no migration/recovery changes to commit. Avoid a
        // full IPC upload, serialization and fsync of the entire saved history.
        if (current.current !== data) await persist(current.current)
        if (disposed) { release(); return }
        ready.current = true
        setState(current.current)
        // Only potentially interrupted executions need automatic recovery.
        // Completed historical tasks wait until the user opens or exports them.
        for (const task of current.current.tasks) if (task.historyPending && task.runs.some(run => run.members.some(member => member.status === 'running'))) {
          void ensureTaskReady(task.id).catch(() => {})
        }
      } catch (e) { if (!disposed) setError(`加载本地数据失败：${String(e)}`) }
    })()
    return () => { disposed = true; controller.abort(); hydration.current.clear(); buffered.current.clear(); ready.current = false; release() }
  }, [persist, update, ensureTaskReady])
  return { state, update, error, clearError: () => setError(''), saved, ensureTaskReady, historyErrors }
}
