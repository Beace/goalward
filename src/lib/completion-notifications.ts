import type { AppState } from './types'
import { translate } from '@/i18n'

export interface CompletionNotification { title: string; body: string }

/** Compare live transitions only. Loading/recovering history must stay silent. */
export function completionNotifications(before: AppState, after: AppState): CompletionNotification[] {
  const previous = new Map(before.tasks.map(task => [task.id, task]))
  return after.tasks.flatMap(task => {
    const old = previous.get(task.id)
    if (!old || old === task || old.demo || task.demo) return []
    const name = task.title.trim().replace(/\s+/g, ' ').slice(0, 120) || translate('未命名任务', 'Untitled task')
    if (old.businessStatus !== 'done' && task.businessStatus === 'done') {
      return [{ title: translate('任务已完成', 'Task completed'), body: name }]
    }
    if (old.historyPending || task.historyPending || old.runs === task.runs) return []
    const runs = new Map(old.runs.map(run => [run.id, run]))
    return task.runs.flatMap(run => {
      const prior = runs.get(run.id)
      if (!prior?.members.some(member => member.status === 'running') || !run.members.length ||
        run.members.some(member => member.status === 'running')) return []
      // A user stop or startup recovery is not a successful conversation ending.
      if (run.members.some(member => member.status === 'stopped' || member.status === 'interrupted')) return []
      const failed = run.members.some(member => member.status === 'failed')
      const step = task.plan?.find(step => step.id === run.stepId)
      return [{
        title: failed ? translate('对话执行失败', 'Conversation run failed') : translate('对话已结束', 'Conversation ended'),
        body: `${name}${step ? ` · ${step.title}` : ''}${failed ? translate('：请查看执行过程中的错误。', ': See the error in the execution trace.') : translate('：本轮回复已完成。', ': This run’s response is complete.')}`,
      }]
    })
  })
}
