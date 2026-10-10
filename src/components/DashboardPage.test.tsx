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
    const active = createGoal({ title: '交付 Dashboard', expected: '页面可用', criteria: ['统计准确', '交互可达'] }, '2026-09-17T07:00:00.000Z')
    active.criteria[0] = { ...active.criteria[0], status: 'satisfied', evidence: '测试通过', checkedAt: '2026-09-17T07:30:00.000Z' }
    const achieved = createGoal({ title: '完成设计规范', expected: '规范落地', criteria: ['已评审'] }, '2026-09-15T07:00:00.000Z')
    achieved.criteria[0] = { ...achieved.criteria[0], status: 'satisfied', evidence: '评审记录', checkedAt: '2026-09-16T06:00:00.000Z' }
    achieved.status = 'achieved'
    const task = createWorkspaceTask(state.settings, { title: '实现 Dashboard 页面', directory: '/tmp', goalId: active.id })
    task.createdAt = '2026-09-17T06:00:00.000Z'
    task.businessStatus = 'done'
    task.results = [{ id: 'result', summary: '已完成', evidence: '构建通过', createdAt: '2026-09-17T07:45:00.000Z', verdict: 'accepted', reviewedAt: '2026-09-17T07:50:00.000Z' }]
    state.goals = [active, achieved]
    state.tasks = [task, ...state.tasks]
    const onGoal = vi.fn(), onTask = vi.fn()

    render(<DashboardPage state={state} onGoal={onGoal} onTask={onTask} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '进行中目标标准平均验收率 50%' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '目标完成率 50%' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '目标标准验收进度' })).getByText('1 / 2')).toBeTruthy()
    expect(screen.queryByText('为工作台增加全局命令面板')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /继续执行/ }))
    expect(onTask).toHaveBeenCalledWith(task.id)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(onGoal).toHaveBeenCalledWith(active.id)
  })

  it('keeps goal verification undefined without criteria and excludes assistant tasks from business metrics and lists', () => {
    const now = new Date('2026-10-10T08:00:00.000Z')
    const state = createInitialState()
    const goal = createGoal({ title: '目标结果尚未定义', expected: '仍需确认验收方式' })
    const task = createWorkspaceTask(state.settings, { title: '真正交付的任务', goalId: goal.id })
    task.businessStatus = 'done'
    task.createdAt = now.toISOString()
    task.results = [{ id: 'accepted', summary: '交付', evidence: '检查记录', createdAt: now.toISOString(), verdict: 'accepted' }]
    const assistant = { ...createWorkspaceTask(state.settings, { title: '内部目标助手对话', goalId: goal.id }), kind: 'goal_assistant' as const }
    const cancelled = { ...createWorkspaceTask(state.settings, { title: '取消的真实任务', goalId: goal.id }), businessStatus: 'cancelled' as const }
    state.goals = [goal]
    state.tasks = [assistant, task, cancelled, ...state.tasks]
    render(<DashboardPage state={state} onGoal={vi.fn()} onTask={vi.fn()} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.queryByText('内部目标助手对话')).toBeNull()
    expect(screen.getByText('取消的真实任务')).toBeTruthy()
    expect(screen.getByLabelText('目标结果尚未定义：目标标准验收率 —')).toBeTruthy()
    expect(screen.getByLabelText('目标验收进度未定义')).toBeTruthy()
    expect(screen.queryByRole('progressbar', { name: /进行中目标标准平均验收率/ })).toBeNull()
    expect(screen.getByRole('button', { name: '目标结果尚未定义：任务完成 1 / 1，查看任务' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '本周任务完成率 100%' })).toBeTruthy()
  })

  it('requires latest acceptance for completion and uses review time rather than later runtime or chat activity for done today', () => {
    const now = new Date('2026-10-10T08:00:00.000Z')
    const state = createInitialState()
    const goal = createGoal({ title: '核对结果', expected: '有验收依据', criteria: ['符合要求'] })
    goal.criteria[0] = { ...goal.criteria[0], status: 'satisfied', evidence: ' ' }
    const accepted = { id: 'accepted', summary: '交付', evidence: '检查记录', createdAt: '2026-10-09T08:00:00.000Z', reviewedAt: '2026-10-09T08:10:00.000Z', verdict: 'accepted' as const }
    const oldDone = createWorkspaceTask(state.settings, { title: '昨天验收今天讨论', goalId: goal.id })
    oldDone.businessStatus = 'done'
    oldDone.results = [accepted]
    oldDone.messages = [{ id: 'message', role: 'user', text: '追加讨论', createdAt: now.toISOString() }]
    const reopened = { ...createWorkspaceTask(state.settings, { title: '新结果尚未验收', goalId: goal.id }), businessStatus: 'done' as const,
      results: [accepted, { ...accepted, id: 'submitted', verdict: 'submitted' as const, createdAt: now.toISOString(), reviewedAt: undefined }] }
    state.goals = [goal]
    state.tasks = [oldDone, reopened]
    render(<DashboardPage state={state} onGoal={vi.fn()} onTask={vi.fn()} onGoals={vi.fn()} onTasks={vi.fn()} onNewTask={vi.fn()} now={now} />)

    expect(screen.getByRole('progressbar', { name: '本周任务完成率 50%' })).toBeTruthy()
    expect(screen.getByText('50% 完成 · 今日完成 0 · 未开始 0')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '进行中目标标准平均验收率 0%' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '符合要求：待验证' })).toBeTruthy()
    expect(within(screen.getByRole('row', { name: /新结果尚未验收/ })).getByText('待验收')).toBeTruthy()
  })
})
