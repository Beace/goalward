// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createWorkspaceTask } from '@/lib/workspace'
import { GoalProgress } from './GoalProgress'

afterEach(cleanup)

describe('GoalProgress', () => {
  it('opens tasks and individual criteria with native accessible controls, retaining focus on evidence updates', () => {
    const state = createInitialState()
    const goal = createGoal({ title: 'Deliver a verifiable page', criteria: ['Keyboard operable', 'Goal result meets requirements'] })
    goal.criteria[0] = { ...goal.criteria[0], status: 'satisfied', evidence: 'Keyboard check records' }
    const task = createWorkspaceTask(state.settings, { title: 'Complete page', goalId: goal.id })
    task.businessStatus = 'done'
    task.results = [{ id: 'result', summary: 'Page completed', evidence: 'Artifact', verdict: 'accepted', createdAt: task.createdAt }]
    const onTasks = vi.fn(), onCriterion = vi.fn()
    const { rerender } = render(<GoalProgress goal={goal} tasks={[task]} onTasks={onTasks} onCriterion={onCriterion} />)
    const taskLink = screen.getByRole('button', { name: 'Deliver a verifiable page：任务完成 1 / 1，查看任务' })
    taskLink.focus()
    expect(document.activeElement).toBe(taskLink)
    fireEvent.click(taskLink)
    expect(onTasks).toHaveBeenCalledOnce()
    const criterionButton = screen.getByRole('button', { name: 'Goal result meets requirements：待验证' })
    criterionButton.focus()
    fireEvent.click(criterionButton)
    expect(onCriterion).toHaveBeenCalledWith(goal.criteria[1])

    const updated = { ...goal, criteria: [goal.criteria[0], { ...goal.criteria[1], status: 'unsatisfied' as const, evidence: 'On-site check did not meet requirements' }] }
    rerender(<GoalProgress goal={updated} tasks={[task]} onTasks={onTasks} onCriterion={onCriterion} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Goal result meets requirements：未满足' }))
    expect(within(screen.getByRole('region', { name: '目标标准验收进度' })).getByText('1 / 2')).toBeTruthy()
    expect(screen.queryByText('100%')).toBeNull()
  })

  it('shows undefined denominators and exposes missing evidence as unverified', () => {
    const goal = createGoal({ title: 'No acceptance criteria' })
    const { rerender } = render(<GoalProgress goal={goal} tasks={[]} onTasks={vi.fn()} onCriterion={vi.fn()} />)
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByText('尚未定义完成标准')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    const criterion = { id: 'unproven', text: 'Cannot confirm requirements are met', status: 'satisfied' as const, evidence: ' ' }
    rerender(<GoalProgress goal={{ ...goal, criteria: [criterion] }} tasks={[]} onTasks={vi.fn()} onCriterion={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cannot confirm requirements are met：待验证' }).dataset.status).toBe('pending')
    expect(within(screen.getByRole('region', { name: '目标标准验收进度' })).getByText('0 / 1')).toBeTruthy()
  })
})
