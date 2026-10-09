// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalsPage } from './GoalsPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import type { AppState } from '@/lib/types'

// jsdom does not provide layout observation; real resizing is covered by the browser smoke test.
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function initial(): AppState {
  const state = createInitialState()
  return { ...state, goals: [], agents: [], tasks: [], settings: { ...state.settings, runtimes: state.settings.runtimes.map(runtime => ({ ...runtime, enabled: false })) } }
}
function mount(seed = initial(), failure = false) {
  const saved = vi.fn()
  function Harness() {
    const [state, setState] = useState(seed)
    return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { if (failure) throw new Error('无法写入本地状态'); const next = reducer(state); saved(next); setState(next) }} />
  }
  render(<Harness />)
  return saved
}

describe('GoalsPage user-controlled lifecycle', () => {
  it('creates a real empty goal without any enabled runtime or made-up facts', async () => {
    const saved = mount()
    fireEvent.click(screen.getByRole('button', { name: '创建第一个目标' }))
    const dialog = screen.getByRole('dialog', { name: '创建目标' })
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: '为团队整理知识库' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建目标' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '为团队整理知识库' })).toBeTruthy())
    expect(saved.mock.calls[0][0].goals[0].currentState.entries).toEqual([])
    expect(saved.mock.calls[0][0].tasks).toEqual([])
    expect(screen.getByText('现状还不明确。可以直接描述，也可以记录资料位置和查询方式。')).toBeTruthy()
  })

  it('keeps user input and shows an error if persistence fails', async () => {
    mount(initial(), true)
    fireEvent.click(screen.getByRole('button', { name: '创建第一个目标' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: '不能丢失的目标' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建目标' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法写入本地状态'))
    expect((screen.getByLabelText('目标名称') as HTMLInputElement).value).toBe('不能丢失的目标')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('records user-sourced status changes without overwriting previous versions', async () => {
    const state = initial()
    state.goals = [createGoal({ title: '研究桌面存储方案', currentSummary: '已有候选清单' })]
    const saved = mount(state)
    fireEvent.click(screen.getByRole('button', { name: '更新现状' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('整体描述'), { target: { value: '完成第一轮实验' } })
    fireEvent.change(within(dialog).getByLabelText('新增条目（可选）'), { target: { value: '方案 A 支持本地持久化' } })
    fireEvent.change(within(dialog).getByLabelText('变化原因'), { target: { value: '用户检查实验记录' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByText('方案 A 支持本地持久化')).toBeTruthy())
    const goal = saved.mock.calls[0][0].goals[0]
    expect(goal.currentState.version).toBe(2)
    expect(goal.stateHistory[0].summary).toBe('已有候选清单')
    expect(goal.currentState.entries[0].source.label).toBe('用户提供')
  })
})
