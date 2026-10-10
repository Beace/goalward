import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal } from './goals'
import { createWorkspaceTask } from './workspace'
import { getGoalProgress, isAcceptedTaskDone, isBusinessTask } from './goal-progress'
import type { GoalCriterion } from './goal-types'
import type { Task } from './types'

function fixture() {
  const state = createInitialState()
  const goal = createGoal({ title: '验证交付', expected: '获得可检验结果' })
  const task = (overrides: Partial<Task> = {}): Task => ({ ...createWorkspaceTask(state.settings, { title: '真实任务', goalId: goal.id }), ...overrides })
  return { goal, task }
}
const accepted = { id: 'accepted', summary: '交付结果', evidence: '可复查的验证记录', createdAt: '2026-10-10T00:00:00Z', verdict: 'accepted' as const }

describe('task delivery progress', () => {
  it('requires the latest accepted result, evidence, business acceptance, and matching requirements', () => {
    const { task } = fixture()
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [accepted] }))).toBe(true)
    expect(isAcceptedTaskDone(task({ businessStatus: 'review', results: [accepted] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [{ ...accepted, evidence: ' \n ', reviewNote: ' ' }] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [{ ...accepted, evidence: '', reviewNote: '用户验收记录' }] }))).toBe(true)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [accepted, { ...accepted, id: 'new', verdict: 'submitted' }] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', results: [accepted, { ...accepted, id: 'new', verdict: 'rejected' }] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', requirementsVersion: 1, results: [accepted] }))).toBe(false)
    expect(isAcceptedTaskDone(task({ businessStatus: 'done', requirementsVersion: 1, results: [{ ...accepted, requirementsVersion: 1 }] }))).toBe(true)
  })

  it('excludes demo, internal assistant, cancelled, and unrelated tasks from the denominator', () => {
    const { goal, task } = fixture()
    const cancelled = task({ businessStatus: 'cancelled' })
    const assistant = task({ kind: 'goal_assistant', businessStatus: 'done', results: [accepted] })
    const tasks = [task({ businessStatus: 'done', results: [accepted] }), task({ demo: true }), assistant, cancelled, task({ goalId: 'other' })]
    expect(isBusinessTask(cancelled)).toBe(true)
    expect(isBusinessTask(assistant)).toBe(false)
    expect(getGoalProgress(goal, tasks).tasks).toMatchObject({ total: 1, done: 1, percentage: 100 })
  })

  it('partitions business states and never treats a completed run as a completed task', () => {
    const { goal, task } = fixture()
    const completedRun = task({ runs: [{ id: 'run', createdAt: accepted.createdAt, prompt: '', directory: '', members: [] }],
      events: [{ id: 'event', taskId: 'task', runId: 'run', memberId: '', timestamp: accepted.createdAt, kind: 'completed', text: 'Runtime exited successfully' }] })
    const tasks = [task({ businessStatus: 'done', results: [accepted] }), task({ businessStatus: 'in_progress' }), task({ businessStatus: 'blocked' }),
      task({ businessStatus: 'review' }), task({ businessStatus: 'done', results: [accepted, { ...accepted, id: 'new', verdict: 'submitted' }] }), completedRun]
    const progress = getGoalProgress(goal, tasks)
    expect(progress.tasks).toMatchObject({ total: 6, done: 1, active: 1, blocked: 1, review: 2, pending: 1, percentage: 17 })
    expect(progress.tasks.items.at(-1)?.status).toBe('pending')
    expect(progress.tasks.items.map(item => item.task)).toEqual(tasks)
  })
})

describe('goal criteria verification', () => {
  it('counts both outcomes only with evidence and leaves all other criteria unverified', () => {
    const { goal, task } = fixture()
    const criterion = (id: string, status: GoalCriterion['status'], evidence: string): GoalCriterion => ({ id, text: id, status, evidence })
    goal.criteria = [criterion('satisfied', 'satisfied', '检查通过'), criterion('unsatisfied', 'unsatisfied', '检查未通过'),
      criterion('missing', 'satisfied', ' \n '), criterion('unverified', 'unverified', '尚未评审'), criterion('failed-no-evidence', 'unsatisfied', '')]
    const progress = getGoalProgress(goal, [task({ businessStatus: 'done', results: [accepted] })])
    expect(progress.criteria).toMatchObject({ total: 5, satisfied: 1, unsatisfied: 1, pending: 3, percentage: 20 })
    expect(progress.tasks.percentage).toBe(100)
    expect(progress.criteria.items.map(item => item.status)).toEqual(['satisfied', 'unsatisfied', 'pending', 'pending', 'pending'])
  })

  it('keeps absent criteria undefined even when every task is accepted, and does not mutate records', () => {
    const { goal, task } = fixture()
    const tasks = [task({ businessStatus: 'done', results: [accepted] })]
    const original = structuredClone({ goal, tasks })
    expect(getGoalProgress(goal, tasks).criteria).toMatchObject({ total: 0, percentage: null })
    expect(getGoalProgress(goal, []).tasks).toMatchObject({ total: 0, percentage: null })
    expect({ goal, tasks }).toEqual(original)
  })
})
