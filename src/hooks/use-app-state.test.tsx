// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as domain from '@/lib/domain'
import type { AppState, RuntimeEvent } from '@/lib/types'
import { useAppState } from './use-app-state'

const bridge = vi.hoisted(() => ({
  loadState: vi.fn<() => Promise<AppState | null>>(),
  loadTraceEvents: vi.fn<(state: AppState) => Promise<RuntimeEvent[]>>(),
  loadTaskHistory: vi.fn<(taskId: string, signal?: AbortSignal) => Promise<RuntimeEvent[]>>(),
  onRuntimeEvent: vi.fn<(handler: (event: RuntimeEvent) => void) => Promise<() => void>>(),
  saveState: vi.fn<(state: AppState) => Promise<void>>(),
}))
vi.mock('@/lib/bridge', () => bridge)
const nativeNotification = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>())
vi.mock('@/lib/native-notifications', () => ({ sendNativeNotification: nativeNotification }))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function storedState(): AppState {
  const runtime = { id: 'runtime-1', name: 'Local Harness', executable: 'harness', adapter: 'generic' as const, enabled: true, args: ['--configured'], defaultModel: 'original-model', description: '' }
  const member = { id: 'member-1', name: 'Implementer', role: '实现', runtimeId: runtime.id, modelId: runtime.defaultModel }
  return {
    version: 1, goals: [], agents: [],
    settings: { runtimes: [runtime], models: [], providers: [], defaultRuntime: runtime.id, defaultMode: 'solo', maxParallel: 3, defaultDirectory: '/work/project', outputLimit: 65536 },
    activeTaskId: 'task-1',
    tasks: [{
      id: 'task-1', title: 'Existing task', directory: '/work/project', mode: 'solo', members: [member],
      createdAt: '2026-09-15T01:00:00Z',
      messages: [{ id: 'user-1', role: 'user', text: 'Please implement the feature.', createdAt: '2026-09-15T01:00:00Z' }],
      runs: [{ id: 'run-1', createdAt: '2026-09-15T01:00:00Z', directory: '/work/project', prompt: 'Implement', members: [{ ...member, runtime: { ...runtime, args: [...runtime.args] }, model: runtime.defaultModel, status: 'running' }] }],
      events: [],
    }],
  }
}
function event(id: string, kind: RuntimeEvent['kind'], text = '', overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return { id, kind, text, taskId: 'task-1', runId: 'run-1', memberId: 'member-1', timestamp: '2026-09-15T01:00:01Z', ...overrides }
}
const rename = (title: string) => (state: AppState): AppState => ({ ...state, tasks: state.tasks.map(task => task.id === 'task-1' ? { ...task, title } : task) })
let deliver: ((event: RuntimeEvent) => void) | undefined
let unlisten = vi.fn<() => void>()

beforeEach(() => {
  vi.resetAllMocks()
  nativeNotification.mockResolvedValue(undefined)
  deliver = undefined
  unlisten = vi.fn<() => void>()
  bridge.loadState.mockResolvedValue(storedState())
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.loadTaskHistory.mockResolvedValue([])
  bridge.onRuntimeEvent.mockImplementation(async handler => { deliver = handler; return unlisten })
  bridge.saveState.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function mountReady() {
  const hook = renderHook(() => useAppState())
  await waitFor(() => expect(hook.result.current.state).not.toBeNull())
  expect(hook.result.current.saved).toBe(true)
  return hook
}

describe('native completion notifications', () => {
  async function liveTask(team = false) {
    const hook = await mountReady()
    await act(async () => { await hook.result.current.update(state => ({ ...state, tasks: state.tasks.map(task => ({
      ...task, runs: task.runs.map(run => ({ ...run, members: [
        { ...run.members[0], status: 'running' },
        ...(team ? [{ ...run.members[0], id: 'member-2', status: 'running' as const }] : []),
      ] })),
    })) })) })
    return hook
  }

  it('waits for all members and persistence, then sends exactly once despite repeated terminal signals', async () => {
    const { result } = await liveTask(true)
    await act(async () => { deliver!(event('first', 'completed')) })
    expect(nativeNotification).not.toHaveBeenCalled()
    const written = deferred()
    bridge.saveState.mockReturnValueOnce(written.promise)
    act(() => { deliver!(event('second', 'completed', '', { memberId: 'member-2' })) })
    expect(result.current.state?.tasks[0].runs[0].members.every(member => member.status === 'completed')).toBe(true)
    expect(nativeNotification).not.toHaveBeenCalled()
    await act(async () => { written.resolve() })
    expect(nativeNotification).toHaveBeenCalledExactlyOnceWith({ title: '对话已结束', body: 'Existing task：本轮回复已完成。' })
    await act(async () => {
      deliver!(event('second', 'completed', '', { memberId: 'member-2' }))
      deliver!(event('late-terminal', 'completed'))
      deliver!(event('late-output', 'stdout', 'tail'))
      await result.current.update(rename('renamed'))
    })
    expect(nativeNotification).toHaveBeenCalledTimes(1)
  })

  it('notifies for each new turn, including tasks that are not selected', async () => {
    const { result } = await liveTask()
    await act(async () => {
      await result.current.update(state => ({ ...state, activeTaskId: 'another-task' }))
      deliver!(event('done', 'completed'))
    })
    await act(async () => { await result.current.update(state => ({ ...state, tasks: state.tasks.map(task => ({ ...task,
      runs: [...task.runs, { ...task.runs[0], id: 'run-2', members: task.runs[0].members.map(member => ({ ...member, status: 'running' })) }],
    })) })) })
    await act(async () => { deliver!(event('next-done', 'completed', '', { runId: 'run-2' })) })
    expect(nativeNotification).toHaveBeenCalledTimes(2)
  })

  it('notifies on task completion separately and suppresses a simultaneous turn completion', async () => {
    const { result } = await liveTask()
    await act(async () => { await result.current.update(state => {
      const next = domain.applyRuntimeEvent(state, event('done', 'completed'))
      return { ...next, tasks: next.tasks.map(task => ({ ...task, businessStatus: 'done' })) }
    }) })
    expect(nativeNotification).toHaveBeenCalledExactlyOnceWith({ title: '任务已完成', body: 'Existing task' })
    await act(async () => { await result.current.update(rename('saved again')) })
    expect(nativeNotification).toHaveBeenCalledTimes(1)
  })

  it('does not send for initial or deferred historical recovery', async () => {
    bridge.loadTraceEvents.mockResolvedValue([event('old-done', 'completed')])
    const first = await mountReady()
    expect(nativeNotification).not.toHaveBeenCalled()
    first.unmount()
    const source = storedState()
    source.tasks[0].historyPending = true
    bridge.loadState.mockResolvedValue(source)
    const second = await mountReady()
    await act(async () => { await second.result.current.ensureTaskReady('task-1') })
    expect(nativeNotification).not.toHaveBeenCalled()
  })

  it('keeps failed saves silent and notification errors separate from task persistence', async () => {
    const { result } = await liveTask()
    bridge.saveState.mockRejectedValueOnce(new Error('disk full'))
    await act(async () => { deliver!(event('done', 'completed')) })
    expect(nativeNotification).not.toHaveBeenCalled()
    nativeNotification.mockRejectedValueOnce(new Error('notification service unavailable'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(async () => { await result.current.update(state => ({ ...state, tasks: state.tasks.map(task => ({ ...task, businessStatus: 'done' })) })) })
    expect(result.current.saved).toBe(true)
    expect(warning).toHaveBeenCalledWith('原生通知发送失败：', expect.any(Error))
  })

  it.each(['stopped', 'failed'] as const)('uses the actual %s terminal outcome', async kind => {
    await liveTask()
    await act(async () => { deliver!(event('end', kind)) })
    if (kind === 'stopped') expect(nativeNotification).not.toHaveBeenCalled()
    else expect(nativeNotification).toHaveBeenCalledExactlyOnceWith({ title: '对话执行失败', body: 'Existing task：请查看执行过程中的错误。' })
  })
})

describe('useAppState initialization and recovery', () => {
  it('shows the workspace before historical events and journals are requested', async () => {
    const source = storedState()
    source.tasks[0].historyPending = true
    source.tasks[0].runs[0].members[0].status = 'completed'
    bridge.loadState.mockResolvedValue(source)
    const pending = deferred<RuntimeEvent[]>()
    bridge.loadTaskHistory.mockReturnValue(pending.promise)
    const { result } = await mountReady()
    expect(result.current.state?.tasks[0].messages).toEqual(source.tasks[0].messages)
    expect(bridge.loadTaskHistory).not.toHaveBeenCalled()
    expect(bridge.loadTraceEvents).not.toHaveBeenCalled()
    let hydration!: Promise<unknown>
    act(() => { hydration = result.current.ensureTaskReady('task-1') })
    expect(result.current.state).not.toBeNull()
    await act(async () => { await result.current.update(rename('edited while loading')) })
    await act(async () => { pending.resolve([event('historical', 'stdout', 'Original answer')]); await hydration })
    expect(result.current.state?.tasks[0].title).toBe('edited while loading')
    expect(result.current.state?.tasks[0].messages.map(message => message.text)).toContain('Original answer')
    expect(result.current.state?.tasks[0].historyPending).toBeUndefined()
  })

  it('deduplicates history requests and buffers live events until the historical protocol prefix is available', async () => {
    const source = storedState()
    source.tasks[0].historyPending = true
    bridge.loadState.mockResolvedValue(source)
    const pending = deferred<RuntimeEvent[]>()
    bridge.loadTaskHistory.mockReturnValue(pending.promise)
    const { result } = await mountReady()
    expect(bridge.loadTaskHistory).toHaveBeenCalledTimes(1)
    let first!: Promise<unknown>, second!: Promise<unknown>
    act(() => {
      first = result.current.ensureTaskReady('task-1')
      second = result.current.ensureTaskReady('task-1')
      deliver!(event('live', 'stdout', ' live tail'))
      deliver!(event('done', 'completed'))
    })
    expect(first).toBe(second)
    expect(result.current.state?.tasks[0].messages).toEqual(source.tasks[0].messages)
    await act(async () => { pending.resolve([event('stored', 'stdout', 'Stored prefix')]); await first })
    expect(result.current.state?.tasks[0].events.map(event => event.id)).toEqual(['stored', 'live', 'done'])
    expect(result.current.state?.tasks[0].messages.at(-1)?.text).toBe('Stored prefix live tail')
    expect(result.current.state?.tasks[0].runs[0].members[0].status).toBe('completed')
  })

  it('keeps history errors local, supports retry, and never resurrects a deleted task', async () => {
    const source = storedState()
    source.tasks[0].historyPending = true
    source.tasks[0].runs[0].members[0].status = 'completed'
    bridge.loadState.mockResolvedValue(source)
    const { result } = await mountReady()
    bridge.loadTaskHistory.mockRejectedValueOnce(new Error('history read failed'))
    await act(async () => { await expect(result.current.ensureTaskReady('task-1')).rejects.toThrow('history read failed') })
    expect(result.current.historyErrors['task-1']).toContain('history read failed')
    expect(result.current.state?.tasks[0].historyPending).toBe(true)
    const pending = deferred<RuntimeEvent[]>()
    bridge.loadTaskHistory.mockReturnValue(pending.promise)
    let hydration!: Promise<unknown>
    act(() => { hydration = result.current.ensureTaskReady('task-1') })
    await act(async () => { await result.current.update(state => ({ ...state, tasks: [] })) })
    await act(async () => { pending.resolve([]); await expect(hydration).rejects.toThrow('任务已不存在') })
    expect(result.current.state?.tasks).toEqual([])
  })

  it('does not expose state before load, trace recovery, listener registration and the initial write finish', async () => {
    const loaded = deferred<AppState | null>()
    const trace = deferred<RuntimeEvent[]>()
    const registered = deferred<() => void>()
    const written = deferred()
    bridge.loadState.mockReturnValue(loaded.promise)
    bridge.loadTraceEvents.mockReturnValue(trace.promise)
    bridge.onRuntimeEvent.mockImplementation(handler => { deliver = handler; return registered.promise })
    bridge.saveState.mockReturnValue(written.promise)
    const source = storedState()
    const { result } = renderHook(() => useAppState())

    expect(result.current.state).toBeNull()
    expect(bridge.loadTraceEvents).not.toHaveBeenCalled()
    expect(bridge.onRuntimeEvent).not.toHaveBeenCalled()
    expect(bridge.saveState).not.toHaveBeenCalled()
    await act(async () => { loaded.resolve(source) })
    expect(bridge.loadTraceEvents).toHaveBeenCalledWith(source)
    expect(result.current.state).toBeNull()
    expect(bridge.onRuntimeEvent).not.toHaveBeenCalled()
    await act(async () => { trace.resolve([]) })
    expect(bridge.onRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(bridge.saveState).not.toHaveBeenCalled()
    expect(result.current.state).toBeNull()
    await act(async () => { registered.resolve(unlisten) })
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBeNull()
    expect(result.current.saved).toBe(false)
    expect(bridge.saveState.mock.calls[0][0].tasks[0].runs[0].members[0].status).toBe('interrupted')
    await act(async () => { written.resolve() })
    expect(result.current.state).toEqual(bridge.saveState.mock.calls[0][0])
    expect(result.current.saved).toBe(true)
    expect(result.current.error).toBe('')
  })

  it('applies recovered trace evidence before interrupting only the remaining stale members', async () => {
    const source = storedState()
    source.tasks[0].runs[0].members.push({ ...source.tasks[0].runs[0].members[0], id: 'member-2', name: 'Reviewer' })
    const recoveredEvents = [event('recovered-output', 'stdout', 'Recovered public answer.'), event('recovered-completion', 'completed', '', { exitCode: 0 })]
    bridge.loadState.mockResolvedValue(source)
    bridge.loadTraceEvents.mockResolvedValue(recoveredEvents)
    // Spy through the real recovery implementation: its input must already contain
    // the recovered completion, not merely reach the same final status by chance.
    const recovery = vi.spyOn(domain, 'recoverInterruptedState')
    const { result } = await mountReady()

    expect(recovery).toHaveBeenCalledTimes(1)
    const beforeInterruption = recovery.mock.calls[0][0].tasks[0]
    expect(beforeInterruption.events).toEqual(recoveredEvents)
    expect(beforeInterruption.runs[0].members.map(member => member.status)).toEqual(['completed', 'running'])
    expect(result.current.state?.tasks[0].messages.map(message => message.text)).toContain('Recovered public answer.')
    expect(result.current.state?.tasks[0].runs[0].members.map(member => member.status)).toEqual(['completed', 'interrupted'])
    expect(bridge.saveState.mock.calls[0][0]).toEqual(result.current.state)
    expect(source.tasks[0].runs[0].members.map(member => member.status)).toEqual(['running', 'running'])
    expect(source.tasks[0].events).toEqual([])
  })

  it('retains events delivered during listener registration and waits for the coalesced initial snapshot', async () => {
    const registered = deferred<() => void>()
    const firstWrite = deferred()
    const latestWrite = deferred()
    bridge.onRuntimeEvent.mockImplementation(handler => { deliver = handler; return registered.promise })
    bridge.saveState.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(latestWrite.promise)
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(deliver).toBeTypeOf('function'))
    act(() => { deliver!(event('early-1', 'stdout', 'before registration ')) })
    expect(result.current.state).toBeNull()
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    await act(async () => { registered.resolve(unlisten) })
    act(() => { deliver!(event('early-2', 'stdout', 'before initial commit')) })
    expect(result.current.state).toBeNull()
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    await act(async () => { firstWrite.resolve() })
    expect(bridge.saveState).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBeNull()
    expect(bridge.saveState.mock.calls[1][0].tasks[0].events.map(item => item.id)).toEqual(['early-1', 'early-2'])
    await act(async () => { latestWrite.resolve() })
    expect(result.current.state?.tasks[0].messages.at(-1)?.text).toBe('before registration before initial commit')
    expect(result.current.state?.tasks[0].events).toHaveLength(2)
    expect(result.current.saved).toBe(true)
  })

  it('keeps the app unready and exposes an initial persistence failure', async () => {
    bridge.saveState.mockRejectedValueOnce(new Error('initial disk full'))
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.error).toContain('initial disk full'))
    expect(result.current.state).toBeNull()
    expect(result.current.saved).toBe(false)
    expect(bridge.onRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
  })
})

describe('useAppState persistence and concurrent updates', () => {
  it('does not rewrite a clean current-version snapshot on reopen', async () => {
    const { result, unmount } = await mountReady()
    const persisted = result.current.state!
    unmount()
    bridge.saveState.mockClear()
    bridge.loadState.mockResolvedValue(persisted)
    bridge.loadTraceEvents.mockResolvedValue(persisted.tasks.flatMap(task => task.events))
    const reopened = await mountReady()
    expect(reopened.result.current.state).toBe(persisted)
    expect(bridge.saveState).not.toHaveBeenCalled()
  })

  it('publishes live output immediately while disk persistence is still in flight', async () => {
    const { result } = await mountReady()
    const pendingWrite = deferred()
    bridge.saveState.mockClear()
    bridge.saveState.mockReturnValueOnce(pendingWrite.promise)
    act(() => { deliver!(event('live-1', 'stdout', '第一段')) })
    expect(result.current.state?.tasks[0].messages.at(-1)?.text).toBe('第一段')
    expect(result.current.saved).toBe(false)
    act(() => { deliver!(event('live-2', 'stdout', '，第二段')) })
    expect(result.current.state?.tasks[0].messages.at(-1)?.text).toBe('第一段，第二段')
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    act(() => { deliver!(event('live-done', 'completed', '', { exitCode: 0 })) })
    expect(result.current.state?.tasks[0].runs[0].members[0].status).toBe('completed')
    await act(async () => { pendingWrite.resolve() })
    await waitFor(() => expect(result.current.saved).toBe(true))
    expect(bridge.saveState.mock.calls.at(-1)?.[0].tasks[0].messages.at(-1)?.text).toBe('第一段，第二段')
  })

  it('coalesces pending writes to the latest snapshot while resolving every submitted revision', async () => {
    const { result } = await mountReady()
    const firstWrite = deferred()
    const latestWrite = deferred()
    bridge.saveState.mockClear()
    bridge.saveState.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(latestWrite.promise)
    const settled: string[] = []
    let first!: Promise<void>, middle!: Promise<void>, latest!: Promise<void>
    act(() => {
      first = result.current.update(state => ({ ...state, settings: { ...state.settings, maxParallel: 2 } })).then(() => { settled.push('first') })
      middle = result.current.update(rename('renamed during save')).then(() => { settled.push('middle') })
      latest = result.current.update(state => ({ ...state, settings: { ...state.settings, defaultDirectory: '/work/new' } })).then(() => { settled.push('latest') })
    })
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    expect(bridge.saveState.mock.calls[0][0].tasks[0].title).toBe('Existing task')
    expect(result.current.state?.tasks[0].title).toBe('renamed during save')
    expect(result.current.saved).toBe(false)
    expect(settled).toEqual([])
    await act(async () => { firstWrite.resolve(); await first })
    expect(settled).toEqual(['first'])
    expect(bridge.saveState).toHaveBeenCalledTimes(2)
    expect(bridge.saveState.mock.calls[1][0]).toMatchObject({ settings: { maxParallel: 2, defaultDirectory: '/work/new' }, tasks: [{ title: 'renamed during save' }] })
    expect(result.current.saved).toBe(false)
    await act(async () => { latestWrite.resolve(); await Promise.all([middle, latest]) })
    expect(settled).toEqual(['first', 'middle', 'latest'])
    expect(bridge.saveState).toHaveBeenCalledTimes(2)
    expect(result.current.saved).toBe(true)
    expect(result.current.state).toEqual(bridge.saveState.mock.calls[1][0])
  })

  it('rejects failed save callers, retains their edits, and exposes a clearable error', async () => {
    const { result } = await mountReady()
    const failure = new Error('disk full')
    bridge.saveState.mockRejectedValueOnce(failure)
    await act(async () => {
      await expect(result.current.update(rename('unsaved but retained'))).rejects.toBe(failure)
    })
    expect(result.current.state?.tasks[0].title).toBe('unsaved but retained')
    expect(result.current.error).toContain('保存失败')
    expect(result.current.error).toContain('disk full')
    expect(result.current.saved).toBe(false)
    act(() => { result.current.clearError() })
    expect(result.current.error).toBe('')
    expect(result.current.saved).toBe(false)
    await act(async () => { await result.current.update(state => ({ ...state, settings: { ...state.settings, maxParallel: 4 } })) })
    expect(result.current.saved).toBe(true)
    expect(bridge.saveState.mock.calls.at(-1)?.[0].tasks[0].title).toBe('unsaved but retained')
  })

  it('continues with the newest queued snapshot after an older write fails without rejecting newer waiters', async () => {
    const { result } = await mountReady()
    const firstWrite = deferred()
    const latestWrite = deferred()
    const failure = new Error('temporary I/O failure')
    bridge.saveState.mockClear()
    bridge.saveState.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(latestWrite.promise)
    let failedOutcome!: Promise<unknown>, middle!: Promise<void>, latest!: Promise<void>
    const completed: string[] = []
    act(() => {
      failedOutcome = result.current.update(rename('first')).then(() => null, error => error)
      middle = result.current.update(rename('second')).then(() => { completed.push('second') })
      latest = result.current.update(rename('third')).then(() => { completed.push('third') })
    })
    await act(async () => { firstWrite.reject(failure); expect(await failedOutcome).toBe(failure) })
    expect(result.current.error).toContain('temporary I/O failure')
    expect(completed).toEqual([])
    expect(result.current.saved).toBe(false)
    expect(bridge.saveState).toHaveBeenCalledTimes(2)
    expect(bridge.saveState.mock.calls[1][0].tasks[0].title).toBe('third')
    await act(async () => { latestWrite.resolve(); await Promise.all([middle, latest]) })
    expect(completed).toEqual(['second', 'third'])
    expect(result.current.state?.tasks[0].title).toBe('third')
    expect(result.current.saved).toBe(true)
  })

  it('preserves streamed trace, derived chat and historical runtime snapshots across interleaved user updates', async () => {
    const { result } = await mountReady()
    const firstWrite = deferred()
    const latestWrite = deferred()
    bridge.saveState.mockClear()
    bridge.saveState.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(latestWrite.promise)
    let settingsWrite!: Promise<void>, messageWrite!: Promise<void>
    const outputA = event('stream-a', 'stdout', 'hello ')
    const outputB = event('stream-b', 'stdout', 'world')
    const completion = event('stream-done', 'completed', '', { exitCode: 0 })
    act(() => {
      deliver!(outputA)
      settingsWrite = result.current.update(state => ({ ...state, settings: { ...state.settings, runtimes: state.settings.runtimes.map(runtime => ({ ...runtime, defaultModel: 'new-default', adapter: 'claude' })) } }))
      deliver!(outputB)
      messageWrite = result.current.update(state => ({ ...state, tasks: state.tasks.map(task => ({ ...task, title: 'Updated with stream in flight', messages: [...task.messages, { id: 'user-2', role: 'user', text: 'Please add tests too.', createdAt: '2026-09-15T01:00:02Z' }] })) }))
      deliver!(completion)
    })
    const visible = result.current.state!.tasks[0]
    expect(visible.events).toEqual([outputA, outputB, completion])
    expect(visible.messages.map(message => message.text)).toEqual(['Please implement the feature.', 'hello world', 'Please add tests too.'])
    expect(visible.runs[0].members[0]).toMatchObject({ status: 'completed', model: 'original-model', runtime: { adapter: 'generic', defaultModel: 'original-model', args: ['--configured'] } })
    expect(result.current.state?.settings.runtimes[0]).toMatchObject({ adapter: 'claude', defaultModel: 'new-default' })
    expect(bridge.saveState).toHaveBeenCalledTimes(1)
    await act(async () => { firstWrite.resolve() })
    expect(bridge.saveState).toHaveBeenCalledTimes(2)
    expect(bridge.saveState.mock.calls[1][0]).toEqual(result.current.state)
    await act(async () => { latestWrite.resolve(); await Promise.all([settingsWrite, messageWrite]) })
    expect(result.current.saved).toBe(true)
    expect(result.current.state?.tasks[0].events).toEqual([outputA, outputB, completion])
  })

  it('does not write or alter state for duplicate events, no-op updates or a throwing updater', async () => {
    const { result } = await mountReady()
    const output = event('one-delivery', 'stdout', 'once')
    await act(async () => { deliver!(output) })
    bridge.saveState.mockClear()
    const previous = result.current.state
    await act(async () => {
      deliver!(output)
      await result.current.update(state => state)
      await expect(result.current.update(() => { throw new Error('invalid edit') })).rejects.toThrow('invalid edit')
    })
    expect(result.current.state).toBe(previous)
    expect(bridge.saveState).not.toHaveBeenCalled()
    expect(result.current.saved).toBe(true)
  })
})

describe('useAppState listener ownership', () => {
  it('unsubscribes a late registration once and never publishes or initially saves after unmount', async () => {
    const registered = deferred<() => void>()
    bridge.onRuntimeEvent.mockReturnValue(registered.promise)
    const { unmount, result } = renderHook(() => useAppState())
    await waitFor(() => expect(bridge.onRuntimeEvent).toHaveBeenCalledTimes(1))
    unmount()
    expect(unlisten).not.toHaveBeenCalled()
    await act(async () => { registered.resolve(unlisten) })
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(bridge.saveState).not.toHaveBeenCalled()
    expect(result.current.state).toBeNull()
  })

  it('releases an established listener exactly once when unmounted during the initial save', async () => {
    const written = deferred()
    bridge.saveState.mockReturnValueOnce(written.promise)
    const { unmount } = renderHook(() => useAppState())
    await waitFor(() => expect(bridge.saveState).toHaveBeenCalledTimes(1))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
    await act(async () => { written.resolve() })
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
