// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Workbench } from './Workbench'
import { GoalAssistant } from './GoalAssistant'
import { createInitialState, createTask } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import type { Adapter } from '@/lib/types'

vi.mock('@/lib/bridge', async original => ({ ...await original<typeof import('@/lib/bridge')>(), isDesktop: true }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(adapter: Adapter, steer: boolean, followUp: boolean) {
  const state = createInitialState(), goal = createGoal({ title: 'native input' })
  const task = createTask(state.settings, 'native control', '/project', 'solo'), member = task.members[0]
  task.runs = [{ id: 'active', createdAt: task.createdAt, directory: task.directory, workingDirectories: ['/project'], prompt: 'first', members: [{ ...member, model: '', status: 'running', runtime: { ...state.settings.runtimes[0], adapter } }] }]
  task.events = [{ id: 'capabilities', taskId: task.id, runId: 'active', memberId: member.id, timestamp: task.createdAt, kind: 'stdout', text: JSON.stringify({ type: 'runtime.capabilities', steer, followUp, approvals: false }) + '\n' }]
  state.tasks = [task]; state.goals = [goal]; goal.assistant = { taskId: task.id }
  return { state, task, goal }
}
it.each([['codex', true, false, '追加消息'], ['claude', false, true, '排队追加消息'], ['pi', true, true, '追加消息']] as const)('supports %s native input without ending the current Run', async (adapter, steer, followUp, label) => {
  const { state, task } = fixture(adapter, steer, followUp)
  const send = vi.fn(async () => {}), stop = vi.fn()
  render(<Workbench task={task} settings={state.settings} selectedRunId="active" onSelectRun={vi.fn()} onChange={vi.fn()} onSend={send} onStop={stop} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: '任务指令' })
  fireEvent.change(input, { target: { value: '请先检查测试' } })
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(send).toHaveBeenCalledWith('请先检查测试', task.members[0].id))
  expect(task.runs[0].members[0].status).toBe('running')
  fireEvent.click(screen.getByRole('button', { name: '停止执行' }))
  expect(stop).toHaveBeenCalledOnce()
})
it('retains an unsupported Runtime draft and disables active input', () => {
  const { state, task } = fixture('kimi', false, false)
  const send = vi.fn()
  render(<Workbench task={task} settings={state.settings} selectedRunId="active" onSelectRun={vi.fn()} onChange={vi.fn()} onSend={send} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '下一轮继续' } })
  expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(send).not.toHaveBeenCalled()
  expect(input.value).toBe('下一轮继续')
})
it('keeps both stop and append available in the goal assistant', async () => {
  const { state, task, goal } = fixture('codex', true, false)
  task.kind = 'goal_assistant'; task.goalId = goal.id
  const send = vi.fn(async () => {})
  render(<GoalAssistant state={state} goal={goal} onStart={vi.fn()} onChange={vi.fn(async () => {})} onConfirm={vi.fn()} onSend={send} onStop={vi.fn()} />)
  fireEvent.change(screen.getByRole('textbox', { name: '给目标助手的消息' }), { target: { value: '补充一个约束' } })
  expect(screen.getByRole('button', { name: '停止目标助手' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '追加消息' }))
  await waitFor(() => expect(send).toHaveBeenCalledWith(goal.id, '补充一个约束', 'clarify', expect.any(String)))
  expect(task.runs).toHaveLength(1)
})
it('stops the goal assistant immediately while native input acknowledgement is pending', async () => {
  const { state, task, goal } = fixture('codex', true, false)
  task.kind = 'goal_assistant'; task.goalId = goal.id
  let reject!: (error: Error) => void
  const send = vi.fn(() => new Promise<void>((_, fail) => { reject = fail })), stop = vi.fn(async () => {})
  render(<GoalAssistant state={state} goal={goal} onStart={vi.fn()} onChange={vi.fn(async () => {})} onConfirm={vi.fn()} onSend={send} onStop={stop} />)
  const input = screen.getByRole('textbox', { name: '给目标助手的消息' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '需要取消的追加' } })
  fireEvent.click(screen.getByRole('button', { name: '追加消息' }))
  expect(send).toHaveBeenCalledOnce()
  const stopButton = screen.getByRole('button', { name: '停止目标助手' }) as HTMLButtonElement
  expect(stopButton.disabled).toBe(false)
  fireEvent.click(stopButton)
  expect(stop).toHaveBeenCalledWith(goal.id)
  await act(async () => reject(new Error('本轮已停止，追加未确认')))
  expect(input.value).toBe('需要取消的追加')
})
