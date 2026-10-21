// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalsPage } from './GoalsPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createWorkspaceTask } from '@/lib/workspace'
import type { AppState } from '@/lib/types'

// jsdom does not provide layout observation; real resizing is covered by the browser smoke test.
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function initial(): AppState {
  const state = createInitialState()
  return { ...state, goals: [], agents: [], tasks: [], settings: { ...state.settings, runtimes: state.settings.runtimes.map(runtime => ({ ...runtime, enabled: false })) } }
}
function mount(seed = initial(), failure = false) {
  const saved = vi.fn()
  function Harness() {
    const [state, setState] = useState(seed)
    return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { if (failure) throw new Error('Local state cannot be written'); const next = reducer(state); saved(next); setState(next) }} />
  }
  render(<Harness />)
  return saved
}

describe('GoalsPage user-controlled lifecycle', () => {
  it('creates a real empty goal without any enabled runtime or made-up facts', async () => {
    const saved = mount()
    fireEvent.click(screen.getByRole('button', { name: '创建第一个目标' }))
    const dialog = screen.getByRole('dialog', { name: '创建目标' })
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: 'Organize a team knowledge base' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建目标' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Organize a team knowledge base' })).toBeTruthy())
    expect(saved.mock.calls[0][0].goals[0].currentState.entries).toEqual([])
    expect(saved.mock.calls[0][0].tasks).toEqual([])
    expect(screen.getByText('现状还不明确。可以直接描述，也可以记录资料位置和查询方式。')).toBeTruthy()
  })

  it('keeps user input and shows an error if persistence fails', async () => {
    mount(initial(), true)
    fireEvent.click(screen.getByRole('button', { name: '创建第一个目标' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: 'Goal that must be retained' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建目标' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Local state cannot be written'))
    expect((screen.getByLabelText('目标名称') as HTMLInputElement).value).toBe('Goal that must be retained')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('records user-sourced status changes without overwriting previous versions', async () => {
    const state = initial()
    state.goals = [createGoal({ title: 'Research desktop storage options', currentSummary: 'Candidate inventory exists' })]
    const saved = mount(state)
    fireEvent.click(screen.getByRole('button', { name: '更新现状' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('整体描述'), { target: { value: 'Complete the first experiment' } })
    fireEvent.change(within(dialog).getByLabelText('新增条目（可选）'), { target: { value: 'Option A supports local persistence' } })
    fireEvent.change(within(dialog).getByLabelText('变化原因'), { target: { value: 'The user checked experiment records' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByText('Option A supports local persistence')).toBeTruthy())
    const goal = saved.mock.calls[0][0].goals[0]
    expect(goal.currentState.version).toBe(2)
    expect(goal.stateHistory[0].summary).toBe('Candidate inventory exists')
    expect(goal.currentState.entries[0].source.label).toBe('用户提供')
  })

  it('fills the first-run input from a template and opens the goal card without a runtime', async () => {
    const saved = mount()
    expect(screen.getByRole('heading', { name: '你想推进什么？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '发布一个小功能' }))
    expect((screen.getByLabelText('你想推进什么？') as HTMLTextAreaElement).value).toBe('两周内让新用户 10 分钟跑通首个任务')
    fireEvent.click(screen.getByRole('button', { name: '开始整理目标' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: '目标卡片' })).toBeTruthy())
    expect(saved.mock.calls.at(-1)?.[0].goals[0].title).toBe('两周内让新用户 10 分钟跑通首个任务')
    expect(saved.mock.calls.at(-1)?.[0].settings.runtimes.some((runtime: { enabled: boolean }) => runtime.enabled)).toBe(false)
    expect(screen.getByText('为了让验收有针对性，先在右侧写下预期结果，并加一条可以核对的成功条件。选好 Runtime 之后，我会按这个目标继续追问。')).toBeTruthy()
  })

  it('does not show the first-run entry when a goal already exists', () => {
    const state = initial()
    state.goals = [createGoal({ title: 'Existing goal', expected: 'Already defined' })]
    mount(state)
    expect(screen.queryByRole('heading', { name: '你想推进什么？' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Existing goal' })).toBeTruthy()
  })

  it('accepts or returns the first task result on the goal card', async () => {
    const state = initial()
    const goal = createGoal({ title: 'Ship the first task', expected: 'A new user finishes', criteria: ['The first task completes'] })
    goal.status = 'active'
    goal.assistant = { confirmedVersion: goal.version }
    const task = createWorkspaceTask(state.settings, { title: 'Walk through the first task', goalId: goal.id, acceptance: 'The first task completes' })
    task.businessStatus = 'review'
    task.results = [{ id: 'result-1', summary: 'Draft of the first task', evidence: 'notes.md', createdAt: '2026-10-21T00:00:00Z', verdict: 'submitted', requirementsVersion: 0 }]
    state.goals = [goal]
    state.tasks = [task]
    const saved = mount(state)
    const card = screen.getByRole('region', { name: '当前任务验收' })
    expect(within(card).getByText('Draft of the first task')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '验收通过' }))
    expect(within(card).getByRole('alert').textContent).toContain('先勾选')
    fireEvent.click(within(card).getByRole('button', { name: '退回补充' }))
    expect(within(card).getByRole('alert').textContent).toContain('退回时请写上')
    fireEvent.change(within(card).getByLabelText('验收说明'), { target: { value: 'Show the empty state as well' } })
    fireEvent.click(within(card).getByRole('button', { name: '退回补充' }))
    await waitFor(() => expect(saved.mock.calls.at(-1)?.[0].tasks[0].results[0].verdict).toBe('rejected'))
    expect(saved.mock.calls.at(-1)?.[0].tasks[0].results[0].reviewNote).toBe('Show the empty state as well')
    expect(saved.mock.calls.at(-1)?.[0].tasks[0].businessStatus).toBe('in_progress')
  })

  it('marks matching criteria satisfied when the first result is accepted on the card', async () => {
    const state = initial()
    const goal = createGoal({ title: 'Ship the first task', expected: 'A new user finishes', criteria: ['The first task completes'] })
    goal.status = 'active'
    goal.assistant = { confirmedVersion: goal.version }
    const task = createWorkspaceTask(state.settings, { title: 'Walk through the first task', goalId: goal.id, acceptance: 'The first task completes' })
    task.businessStatus = 'review'
    task.results = [{ id: 'result-1', summary: 'Draft of the first task', evidence: 'notes.md', createdAt: '2026-10-21T00:00:00Z', verdict: 'submitted', requirementsVersion: 0 }]
    state.goals = [goal]
    state.tasks = [task]
    const saved = mount(state)
    const card = screen.getByRole('region', { name: '当前任务验收' })
    fireEvent.click(within(card).getByRole('checkbox', { name: 'The first task completes' }))
    fireEvent.click(within(card).getByRole('button', { name: '验收通过' }))
    await waitFor(() => expect(saved.mock.calls.at(-1)?.[0].tasks[0].results[0].verdict).toBe('accepted'))
    expect(saved.mock.calls.at(-1)?.[0].tasks[0].businessStatus).toBe('done')
    expect(saved.mock.calls.at(-1)?.[0].goals[0].criteria[0].status).toBe('satisfied')
    expect(saved.mock.calls.at(-1)?.[0].goals[0].criteria[0].evidence).toContain('The first task completes')
  })
})
