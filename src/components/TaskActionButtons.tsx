import { useId } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { Button } from './ui/button'
import { taskMutationLockReason } from '@/lib/workspace'
import type { Task } from '@/lib/types'

export type TaskActionKind = 'edit' | 'delete'
export type OpenTaskAction = (kind: TaskActionKind, task: Task, trigger: HTMLButtonElement) => void

export function TaskActionButtons({ task, onAction, compact = false }: { task: Task; onAction: OpenTaskAction; compact?: boolean }) {
  const descriptionId = useId()
  const reason = taskMutationLockReason(task)
  return <div className="task-action-buttons" role="group" aria-label={`任务操作：${task.title}`} title={reason || undefined}>
    <TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="ghost" size={compact ? 'icon-sm' : 'sm'} className={compact ? 'task-compact-action' : undefined} aria-label={`编辑任务：${task.title}`} aria-describedby={reason ? descriptionId : undefined} disabled={!!reason} onClick={event => onAction('edit', task, event.currentTarget)}><Pencil size={13} />{!compact && '编辑任务'}</Button></TooltipTrigger><TooltipContent>编辑任务</TooltipContent></Tooltip></TooltipProvider>
    <Button variant="ghost" size="icon-sm" className="task-delete-action" title="删除任务" aria-label={`删除任务：${task.title}`} aria-describedby={reason ? descriptionId : undefined} disabled={!!reason} onClick={event => onAction('delete', task, event.currentTarget)}><Trash2 size={14} /></Button>
    {reason && <span className="sr-only" id={descriptionId}>{reason}</span>}
  </div>
}
