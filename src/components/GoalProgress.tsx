import { ArrowRight, Check, Circle, CircleDot, Clock3, Pause, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { getGoalProgress, type CriterionProgressStatus, type TaskProgressStatus } from '@/lib/goal-progress'
import type { Goal, GoalCriterion } from '@/lib/goal-types'
import type { Task } from '@/lib/types'
import { Button } from './ui/button'
import './goal-progress.css'

export interface GoalProgressProps {
  goal: Goal
  tasks: Task[]
  onTasks: () => void
  onCriterion: (criterion: GoalCriterion) => void
}

const taskStatuses: TaskProgressStatus[] = ['done', 'active', 'blocked', 'review', 'pending']
const taskIcons = { done: Check, active: CircleDot, blocked: Pause, review: Clock3, pending: Circle }
const criterionIcons = { satisfied: Check, unsatisfied: X, pending: Circle }

export function GoalProgress({ goal, tasks, onTasks, onCriterion }: GoalProgressProps) {
  const { t } = useI18n()
  const progress = getGoalProgress(goal, tasks)
  const taskLabels: Record<TaskProgressStatus, string> = {
    done: t('已验收', 'Accepted'), active: t('进行中', 'Active'), blocked: t('受阻', 'Blocked'),
    review: t('待验收', 'In review'), pending: t('未开始', 'Pending'),
  }
  const criterionLabels: Record<CriterionProgressStatus, string> = {
    satisfied: t('已满足', 'Satisfied'), unsatisfied: t('未满足', 'Unsatisfied'), pending: t('待验证', 'Unverified'),
  }
  const taskCount = progress.tasks.total ? `${progress.tasks.done} / ${progress.tasks.total}` : '—'
  const criterionCount = progress.criteria.total ? `${progress.criteria.satisfied} / ${progress.criteria.total}` : '—'

  return <div className="goal-progress" aria-label={`${goal.title}：${t('进度', 'Progress')}`}>
    <div className="goal-progress-charts">
      <section className="goal-progress-chart" aria-label={t('任务交付进度', 'Task delivery progress')}>
        <Button variant="ghost" size="sm" className="goal-progress-heading goal-progress-task-link" onClick={onTasks}
          aria-label={`${goal.title}：${t('任务完成', 'Tasks completed')} ${taskCount}，${t('查看任务', 'View tasks')}`}>
          <span>{t('任务完成', 'Tasks completed')}</span><strong>{taskCount}</strong><ArrowRight size={12} />
        </Button>
        {progress.tasks.total ? <div className="goal-progress-task-segments" role="group" aria-label={t('任务状态分布，点击查看任务', 'Task status distribution. Select to view tasks.')}>
          {taskStatuses.filter(status => progress.tasks[status] > 0).map(status => {
            const Icon = taskIcons[status]
            const label = `${taskLabels[status]} ${progress.tasks[status]}，${t('查看任务', 'View tasks')}`
            return <Button key={status} variant="ghost" size="sm" className="goal-progress-segment" data-status={status}
              style={{ flexGrow: progress.tasks[status] }} onClick={onTasks} aria-label={label} title={label}>
              <Icon size={13} /><span>{progress.tasks[status]}</span>
            </Button>
          })}
        </div> : <div className="goal-progress-empty">{t('尚无关联任务', 'No linked tasks')}</div>}
        <div className="goal-progress-legend">{taskStatuses.filter(status => progress.tasks[status] > 0).map(status =>
          <span key={status} data-status={status}><i aria-hidden="true" />{taskLabels[status]} {progress.tasks[status]}</span>)}</div>
        <p className="goal-progress-note">{t('完成以最新结果验收为准', 'Completion requires the latest accepted result')}</p>
      </section>
      <section className="goal-progress-chart" aria-label={t('目标标准验收进度', 'Goal criteria verification progress')}>
        <div className="goal-progress-heading"><span>{t('目标验收', 'Goal verification')}</span><strong>{criterionCount}</strong></div>
        {progress.criteria.total ? <div className="goal-progress-criterion-segments" role="group" aria-label={t('完成标准，点击查看证据', 'Completion criteria. Select to review evidence.')}>
          {progress.criteria.items.map(({ criterion, status }, index) => {
            const Icon = criterionIcons[status]
            const label = `${criterion.text}：${criterionLabels[status]}`
            return <Button key={criterion.id} variant="ghost" size="sm" className="goal-progress-segment" data-status={status}
              onClick={() => onCriterion(criterion)} aria-label={label} title={label}>
              <Icon size={13} /><span>{index + 1}</span>
            </Button>
          })}
        </div> : <div className="goal-progress-empty">{t('尚未定义完成标准', 'No completion criteria defined')}</div>}
        <div className="goal-progress-legend">{(['satisfied', 'unsatisfied', 'pending'] as const).filter(status => progress.criteria[status] > 0).map(status =>
          <span key={status} data-status={status}><i aria-hidden="true" />{criterionLabels[status]} {progress.criteria[status]}</span>)}</div>
        <p className="goal-progress-note">{progress.criteria.total ? t('无证据的标准保持待验证', 'Criteria without evidence remain unverified') : t('定义检验方式后再记录验收', 'Define verification before recording an assessment')}</p>
      </section>
    </div>
  </div>
}
