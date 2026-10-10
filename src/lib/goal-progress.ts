import type { Goal, GoalCriterion } from './goal-types'
import type { Task } from './types'

export type TaskProgressStatus = 'done' | 'active' | 'blocked' | 'review' | 'pending'
export type CriterionProgressStatus = 'satisfied' | 'unsatisfied' | 'pending'

export interface GoalProgressSummary {
  tasks: Record<TaskProgressStatus, number> & {
    total: number
    percentage: number | null
    items: { task: Task; status: TaskProgressStatus }[]
  }
  criteria: Record<CriterionProgressStatus, number> & {
    total: number
    percentage: number | null
    items: { criterion: GoalCriterion; status: CriterionProgressStatus }[]
  }
}

/** Business lists may retain cancelled tasks; progress denominators exclude them separately. */
export function isBusinessTask(task: Task): boolean {
  return !task.demo && task.kind !== 'goal_assistant'
}

/** A terminated Run, an older accepted result, or a stale requirements version is not delivery. */
export function isAcceptedTaskDone(task: Task): boolean {
  const result = task.results?.at(-1)
  return task.businessStatus === 'done' && result?.verdict === 'accepted'
    && (result.requirementsVersion ?? 0) === (task.requirementsVersion ?? 0)
    && Boolean(result.evidence.trim() || result.reviewNote?.trim())
}

export function getTaskProgressStatus(task: Task): TaskProgressStatus {
  if (isAcceptedTaskDone(task)) return 'done'
  if (task.businessStatus === 'in_progress') return 'active'
  if (task.businessStatus === 'blocked') return 'blocked'
  if (task.businessStatus === 'review' || task.businessStatus === 'done') return 'review'
  return 'pending'
}

export function getCriterionProgressStatus(criterion: GoalCriterion): CriterionProgressStatus {
  if (!criterion.evidence.trim()) return 'pending'
  return criterion.status === 'satisfied' || criterion.status === 'unsatisfied' ? criterion.status : 'pending'
}

/** Independent measures: accepted task deliveries and evidence-backed goal criteria. */
export function getGoalProgress(goal: Goal, tasks: Task[]): GoalProgressSummary {
  const taskItems = tasks.filter(task => task.goalId === goal.id && isBusinessTask(task) && task.businessStatus !== 'cancelled')
    .map(task => ({ task, status: getTaskProgressStatus(task) }))
  const criterionItems = goal.criteria.map(criterion => ({ criterion, status: getCriterionProgressStatus(criterion) }))
  const taskCounts: Record<TaskProgressStatus, number> = { done: 0, active: 0, blocked: 0, review: 0, pending: 0 }
  const criterionCounts: Record<CriterionProgressStatus, number> = { satisfied: 0, unsatisfied: 0, pending: 0 }
  for (const { status } of taskItems) taskCounts[status] += 1
  for (const { status } of criterionItems) criterionCounts[status] += 1
  return {
    tasks: { ...taskCounts, total: taskItems.length, percentage: taskItems.length ? Math.round(taskCounts.done / taskItems.length * 100) : null, items: taskItems },
    criteria: { ...criterionCounts, total: criterionItems.length, percentage: criterionItems.length ? Math.round(criterionCounts.satisfied / criterionItems.length * 100) : null, items: criterionItems },
  }
}
