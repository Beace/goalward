// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createWorkspaceTask } from '@/lib/workspace'

afterEach(cleanup)

describe('DashboardPage', () => {
  it('summarizes real goals and tasks and opens the linked work', () => {
    const now = new Date('2026-09-17T08:00:00.000Z')
    const state = createInitialState()
    const active = createGoal({ title: 'Deliver Dashboard', expected: 'Page is usable', criteria: ['Statistics are accurate', 'Interactions are accessible'] }, '2026-09-17T07:00:00.000Z')
    active.criteria[0] = { ...active.criteria[0], status: 'satisfied', evidence: 'Tests passed', checkedAt: '2026-09-17T07:30:00.000Z' }
    const achieved = createGoal({ title: 'Complete design specification', expected: 'Specification implemented', criteria: ['Reviewed'] }, '2026-09-15T07:00:00.000Z')
    achieved.criteria[0] = { ...achieved.criteria[0], status: 'satisfied', evidence: 'Review records', checkedAt: '2026-09-16T06:00:00.000Z' }
    achieved.status = 'achieved'
    const task = createWorkspaceTask(state.settings, { title: 'Implement Dashboard page', directory: '/tmp', goalId: active.id })
    task.createdAt = '2026-09-17T06:00:00.000Z'
    task.businessStatus = 'done'
    task.results = [{ id: 'result', summary: 'Completed', evidence: 'Build passed', createdAt: '2026-09-17T07:45:00.000Z', verdict: 'accepted', reviewedAt: '2026-09-17T07:50:00.000Z' }]
    state.goals = [active, achieved]
    state.tasks = [task, ...state.tasks]
    const onGoal = vi.fn(), onTask = vi.fn()

    render(<DashboardPage state={state} onGoal={onGoal} onTask={onTask} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '进行中目标标准平均验收率 50%' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '目标完成率 50%' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '目标标准验收进度' })).getByLabelText('1 / 2')).toBeTruthy()
    expect(screen.queryByText('为工作台增加全局命令面板')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /继续执行/ }))
    expect(onTask).toHaveBeenCalledWith(task.id)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(onGoal).toHaveBeenCalledWith(active.id)
  })

  it('keeps goal verification undefined without criteria and excludes assistant tasks from business metrics and lists', () => {
    const now = new Date('2026-10-10T08:00:00.000Z')
    const state = createInitialState()
    const goal = createGoal({ title: 'Goal outcome undefined', expected: 'Acceptance method still needs confirmation' })
    const task = createWorkspaceTask(state.settings, { title: 'Actual delivery task', goalId: goal.id })
    task.businessStatus = 'done'
    task.createdAt = now.toISOString()
    task.results = [{ id: 'accepted', summary: 'Delivery', evidence: 'Check records', createdAt: now.toISOString(), verdict: 'accepted' }]
    const assistant = { ...createWorkspaceTask(state.settings, { title: 'Internal goal assistant conversation', goalId: goal.id }), kind: 'goal_assistant' as const }
    const cancelled = { ...createWorkspaceTask(state.settings, { title: 'Cancelled real task', goalId: goal.id }), businessStatus: 'cancelled' as const }
    state.goals = [goal]
    state.tasks = [assistant, task, cancelled, ...state.tasks]
    render(<DashboardPage state={state} onGoal={vi.fn()} onTask={vi.fn()} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.queryByText('Internal goal assistant conversation')).toBeNull()
    expect(screen.getByText('Cancelled real task')).toBeTruthy()
    expect(screen.getByLabelText('Goal outcome undefined：目标标准验收率 —')).toBeTruthy()
    expect(screen.getByLabelText('目标验收进度未定义')).toBeTruthy()
    expect(screen.queryByRole('progressbar', { name: /进行中目标标准平均验收率/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Goal outcome undefined：任务完成 1 / 1，查看任务' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '本周任务完成率 100%' })).toBeTruthy()
  })

  it('requires latest acceptance for completion and uses review time rather than later runtime or chat activity for done today', () => {
    const now = new Date('2026-10-10T08:00:00.000Z')
    const state = createInitialState()
    const goal = createGoal({ title: 'Verify results', expected: 'Acceptance evidence exists', criteria: ['Meets requirements'] })
    goal.criteria[0] = { ...goal.criteria[0], status: 'satisfied', evidence: ' ' }
    const accepted = { id: 'accepted', summary: 'Delivery', evidence: 'Check records', createdAt: '2026-10-09T08:00:00.000Z', reviewedAt: '2026-10-09T08:10:00.000Z', verdict: 'accepted' as const }
    const oldDone = createWorkspaceTask(state.settings, { title: 'Accepted yesterday and discussed today', goalId: goal.id })
    oldDone.businessStatus = 'done'
    oldDone.results = [accepted]
    oldDone.messages = [{ id: 'message', role: 'user', text: 'Additional discussion', createdAt: now.toISOString() }]
    const reopened = { ...createWorkspaceTask(state.settings, { title: 'New result not accepted yet', goalId: goal.id }), businessStatus: 'done' as const,
      results: [accepted, { ...accepted, id: 'submitted', verdict: 'submitted' as const, createdAt: now.toISOString(), reviewedAt: undefined }] }
    state.goals = [goal]
    state.tasks = [oldDone, reopened]
    render(<DashboardPage state={state} onGoal={vi.fn()} onTask={vi.fn()} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.getByRole('progressbar', { name: '本周任务完成率 50%' })).toBeTruthy()
    expect(screen.getByLabelText('50% 完成 · 今日完成 0 · 未开始 0')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '进行中目标标准平均验收率 0%' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Meets requirements：待验证' })).toBeTruthy()
    expect(within(screen.getByRole('row', { name: /New result not accepted yet/ })).getByText('待验收')).toBeTruthy()
  })
})
