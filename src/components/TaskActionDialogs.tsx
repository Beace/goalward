import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, FolderOpen, Save, Trash2 } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Label } from './ui/label'
import { Checkbox } from './ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { chooseDirectory } from '@/lib/bridge'
import { deleteWorkspaceTask, editWorkspaceTask, getTaskDeletionBlockers, taskMutationLockReason, type TaskEditValues } from '@/lib/workspace'
import type { AppState, Task } from '@/lib/types'
import type { TaskActionKind } from './TaskActionButtons'
import { useI18n } from '@/i18n'

export interface TaskActionSelection { kind: TaskActionKind; task: Task; trigger: HTMLButtonElement }
const fields = (task?: Task): TaskEditValues => ({ title: task?.title ?? '', acceptance: task?.acceptance ?? '', directory: task?.directory ?? '', goalId: task?.goalId, priority: task?.priority ?? 'normal', stageId: task?.stageId, dependencies: [...(task?.dependencies ?? [])] })

/** Kept above task rows so an optimistic delete cannot unmount its error/retry UI. */
export function TaskActionDialogs({ action, state, onChange, onClose, onSaved, onDeleted, onOpenTask }: {
  action: TaskActionSelection | null; state: AppState
  onChange: (fn: (state: AppState) => AppState) => Promise<void>
  onClose: () => void; onSaved: () => void; onDeleted: (taskId: string) => void; onOpenTask: (id: string) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<TaskEditValues>(() => fields(action?.task))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const lastAction = useRef(action)
  const deleted = useRef(false)
  const navigationTarget = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!action) return
    lastAction.current = action
    deleted.current = false
    navigationTarget.current = null
    setDraft(fields(action.task)); setError(''); setBusy(false)
  }, [action])
  const selection = action ?? lastAction.current
  const task = state.tasks.find(item => item.id === selection?.task.id) ?? selection?.task
  const deleting = selection?.kind === 'delete'
  const blockers = task ? getTaskDeletionBlockers(state, task.id) : { reason: t('任务不存在', 'Task not found'), children: [], dependents: [] }
  const lockReason = task ? taskMutationLockReason(task) : t('任务不存在', 'Task not found')
  const blocked = !!(blockers.reason || blockers.children.length || blockers.dependents.length)
  const patch = <K extends keyof TaskEditValues>(key: K, value: TaskEditValues[K]) => setDraft(current => ({ ...current, [key]: value }))
  const close = () => { if (!inFlight.current) onClose() }
  async function submit() {
    if (!selection || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const id = selection.task.id
      await onChange(current => deleting ? deleteWorkspaceTask(current, id) : editWorkspaceTask(current, id, draft))
      if (deleting) { deleted.current = true; onDeleted(id) }
      else onSaved()
      onClose()
    } catch (failure) { setError(String(failure).replace(/^Error: /, '')) }
    finally { inFlight.current = false; setBusy(false) }
  }
  function openRelated(id: string) { navigationTarget.current = id; onClose(); onOpenTask(id) }

  return <Dialog open={!!action} onOpenChange={open => { if (!open) close() }}><DialogContent className="task-action-dialog" showCloseButton={!busy}
    onOpenAutoFocus={event => { event.preventDefault(); (deleting ? cancelButton.current : nameInput.current)?.focus() }}
    onCloseAutoFocus={event => {
      event.preventDefault()
      queueMicrotask(() => {
        const original = lastAction.current?.trigger
        if (navigationTarget.current) document.querySelector<HTMLElement>('[data-task-heading]')?.focus()
        else if (!deleted.current && original?.isConnected) original.focus()
        else document.querySelector<HTMLElement>('[data-task-list-heading]')?.focus()
      })
    }}>
    <form className="task-action-form" onSubmit={event => { event.preventDefault(); if (!busy && (deleting ? !blocked : !!draft.title.trim() && !lockReason)) void submit() }}>
      <DialogHeader><DialogTitle>{deleting ? t('删除任务？', 'Delete task?') : t('编辑任务', 'Edit task')}</DialogTitle><DialogDescription>{deleting ? t('此操作不可撤销，请确认要移除的任务与记录。', 'This cannot be undone. Check the task and records to be removed.') : t('修改当前任务要求；已有对话和历史执行快照保持不变。', 'Update this task. Existing conversations and run snapshots will stay unchanged.')}</DialogDescription></DialogHeader>
      <div className="task-action-scroll">
        {deleting ? <>
          <div className="task-delete-summary"><strong>{task?.title}</strong><p>{task?.messages.length ?? 0} {t('条对话', 'messages')} · {task?.runs.length ?? 0} {t('次执行', 'runs')} · {task?.results?.length ?? 0} {t('项结果', 'results')}</p></div>
          <p>{t('从应用中移除此任务及其聊天、执行、结果记录。', 'Remove this task and its conversations, runs, and results from the app.')}</p>
          <p className="task-action-note">{t('工作目录文件、Agent 档案和目标中已记录的现状、证据与复盘保留。本机已有 Trace 日志文件不在本操作中清除。', 'Workspace files, Agent profiles, and goal context, evidence, and reviews will remain. Existing local Trace log files are not deleted.')}</p>
          {blockers.reason && !busy && <p role="status" className="task-action-lock">{blockers.reason}</p>}
          {!!blockers.children.length && <div className="task-delete-blockers"><strong>{t('请先处理', 'Handle')} {blockers.children.length} {t('个子任务', 'subtasks first')}</strong><p>{t('删除子任务后，再删除当前任务。', 'Delete the subtasks before deleting this task.')}</p>{blockers.children.map(child => <Button type="button" variant="link" key={child.id} onClick={() => openRelated(child.id)}>{child.title}<ArrowUpRight size={13} /></Button>)}</div>}
          {!!blockers.dependents.length && <div className="task-delete-blockers"><strong>{blockers.dependents.length} {t('个任务仍依赖此任务', 'tasks still depend on this task')}</strong><p>{t('请编辑以下任务，移除对应的前置依赖。', 'Edit the following tasks to remove this dependency.')}</p>{blockers.dependents.map(dependent => <Button type="button" variant="link" key={dependent.id} onClick={() => openRelated(dependent.id)}>{dependent.title}<ArrowUpRight size={13} /></Button>)}</div>}
        </> : <>
          <div className="task-edit-field"><Label htmlFor="edit-task-name">{t('任务名称', 'Task name')}</Label><Input ref={nameInput} id="edit-task-name" aria-label={t('编辑任务名称', 'Edit task name')} required value={draft.title} disabled={busy} onChange={event => patch('title', event.target.value)} /></div>
          <div className="task-edit-grid"><div className="task-edit-field"><Label>{t('所属目标', 'Goal')}</Label><Select disabled={busy || !!task?.parentTaskId} value={draft.goalId ?? 'none'} onValueChange={value => setDraft(current => ({ ...current, goalId: value === 'none' ? undefined : value, stageId: undefined }))}><SelectTrigger aria-label={t('任务所属目标', 'Task goal')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('独立任务', 'Independent task')}</SelectItem>{state.goals.map(goal => <SelectItem key={goal.id} value={goal.id}>{goal.title}</SelectItem>)}</SelectContent></Select></div><div className="task-edit-field"><Label>{t('优先级', 'Priority')}</Label><Select disabled={busy} value={draft.priority ?? 'normal'} onValueChange={value => patch('priority', value as TaskEditValues['priority'])}><SelectTrigger aria-label={t('任务优先级', 'Task priority')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">{t('低优先级', 'Low')}</SelectItem><SelectItem value="normal">{t('普通优先级', 'Normal')}</SelectItem><SelectItem value="high">{t('高优先级', 'High')}</SelectItem></SelectContent></Select></div></div>
          {task?.parentTaskId && <p className="task-action-note">{t('子任务继承父任务的所属目标。', 'Subtasks inherit their parent task’s goal.')}</p>}
          <div className="task-edit-field"><Label htmlFor="edit-task-acceptance">{t('验收要求', 'Acceptance criteria')}</Label><Textarea id="edit-task-acceptance" aria-label={t('编辑验收要求', 'Edit acceptance criteria')} value={draft.acceptance} disabled={busy} onChange={event => patch('acceptance', event.target.value)} placeholder={t('希望交付什么，怎样确认已经完成', 'What should be delivered, and how will completion be verified?')} /></div>
          <div className="task-edit-field"><Label htmlFor="edit-task-directory">{t('工作目录', 'Working directory')}</Label><div className="task-edit-directory"><Input id="edit-task-directory" aria-label={t('编辑任务目录', 'Edit task directory')} value={draft.directory} disabled={busy} onChange={event => patch('directory', event.target.value)} placeholder={t('执行前填写，可先留空', 'Set before running; optional for now')} /><Button type="button" size="icon-sm" variant="outline" aria-label={t('选择任务工作目录', 'Choose task working directory')} disabled={busy} onClick={() => void chooseDirectory().then(value => { if (value) patch('directory', value) }).catch(failure => setError(String(failure).replace(/^Error: /, '')))}><FolderOpen size={14} /></Button></div></div>
          <div className="task-edit-field"><Label>{t('推进阶段', 'Stage')}</Label><Select disabled={busy || !draft.goalId} value={draft.stageId ?? 'none'} onValueChange={value => patch('stageId', value === 'none' ? undefined : value)}><SelectTrigger aria-label={t('任务推进阶段', 'Task stage')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('未分配阶段', 'Unassigned')}</SelectItem>{state.goals.find(goal => goal.id === draft.goalId)?.plan.map(stage => <SelectItem key={stage.id} value={stage.id}>{stage.title}</SelectItem>)}</SelectContent></Select></div>
          <fieldset className="task-edit-field" disabled={busy}><legend>{t('前置任务', 'Dependencies')}</legend><div className="check-list">{state.tasks.filter(item => item.id !== task?.id && !item.demo).map(item => <Label key={item.id}><Checkbox checked={draft.dependencies.includes(item.id)} onCheckedChange={checked => patch('dependencies', checked ? [...draft.dependencies, item.id] : draft.dependencies.filter(id => id !== item.id))} />{item.title}</Label>)}{!state.tasks.some(item => item.id !== task?.id && !item.demo) && <p className="task-action-note">{t('没有可选的前置任务。', 'No available dependencies.')}</p>}</div></fieldset>
          <p className="task-action-note">{t('Agent 成员、Runtime 和模型仍在任务工作台中配置。', 'Configure Agents, runtimes, and models in the task workbench.')}</p>
          {lockReason && <p role="status" className="task-action-lock">{lockReason}</p>}
        </>}
        {error && <p role="alert" className="task-action-error">{error}</p>}
      </div>
      <DialogFooter><Button ref={cancelButton} type="button" variant="outline" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</Button><Button type="submit" variant={deleting ? 'destructive' : 'default'} disabled={busy || (deleting ? blocked : !draft.title.trim() || !!lockReason)}>{deleting ? <Trash2 size={14} /> : <Save size={14} />}{busy ? deleting ? t('删除中…', 'Deleting…') : t('保存中…', 'Saving…') : deleting ? t('删除任务', 'Delete task') : t('保存任务', 'Save task')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
