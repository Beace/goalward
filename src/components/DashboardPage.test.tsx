// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createWorkspaceTask } from '@/lib/workspace'

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
    expect(screen.getByRole('progressbar', { name: '进行中目标平均进度 50%' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '目标完成率 50%' })).toBeTruthy()
    expect(screen.getByText('1 / 2 项成功条件已满足')).toBeTruthy()
    expect(screen.queryByText('为工作台增加全局命令面板')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /继续执行/ }))
    expect(onTask).toHaveBeenCalledWith(task.id)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(onGoal).toHaveBeenCalledWith(active.id)
  })
})
