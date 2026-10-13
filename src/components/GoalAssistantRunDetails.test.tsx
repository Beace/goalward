// @vitest-environment jsdom
import { semanticText } from '@/test/semantic-text'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createGoalAssistantTask } from '@/lib/goal-assistant'
import { captureRunContext } from '@/lib/workspace'
import type { Run, RuntimeEvent } from '@/lib/types'
import { GoalAssistantRunDetails } from './GoalAssistantRunDetails'

vi.mock('./MarkdownMessage', () => ({ MarkdownMessage: ({ text }: { text: string }) => <div className="markdown-body">{text}</div> }))
vi.mock('./TracePanel', () => ({ TracePanel: ({ task, run }: { task: { id: string }; run: Run }) => <aside aria-label="执行检查器">{task.id}:{run.id}</aside> }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  const state = createInitialState()
  const goal = createGoal({ title: '整理资料' })
  goal.assistant = { requestPhase: 'plan' }
  const task = createGoalAssistantTask(state.settings, { goalId: goal.id, directory: '/app/assistant' })
  state.goals = [goal]
  const run: Run = { id: 'plan-run', prompt: '应用记录的本轮指令', directory: task.directory, createdAt: '2026-10-12T01:00:00Z', context: captureRunContext(state, task), members: [{ ...task.members[0], runtime: state.settings.runtimes[0], model: 'saved-model', effectiveReasoningEffort: 'high', status: 'running', sessionId: 'thread-1' }] }
  task.runs = [run]
  const event = (payload: unknown, kind: RuntimeEvent['kind'] = 'stdout'): RuntimeEvent => ({ id: 'event', kind, taskId: task.id, runId: run.id, memberId: run.members[0].id, timestamp: run.createdAt, text: JSON.stringify(payload) + '\n' })
  return { state, task, run, event }
}

describe('Goal assistant invocation details', () => {
  it('shows the saved Runtime default when this run inherits a known model', () => {
    const { task, run } = fixture()
    run.members[0] = { ...run.members[0], model: '', runtime: { ...run.members[0].runtime, defaultModel: 'saved-runtime-default' } }
    render(<GoalAssistantRunDetails task={task} run={run} />)
    expect(screen.getByText('Codex · saved-runtime-default')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '调用详情' }))
    expect(screen.getByText('saved-runtime-default')).toBeTruthy()
  })
  it('keeps a compact live state and discloses saved request, IDs, instructions and bounded trace on demand', async () => {
    const { task, run } = fixture()
    render(<GoalAssistantRunDetails task={task} run={run} />)
    expect(screen.getByRole('status').textContent).toContain('正在启动 Runtime')
    expect(screen.getByText(/saved-model/)).toBeTruthy()
    expect(screen.queryByText('执行 ID')).toBeNull()
    const trigger = screen.getByRole('button', { name: '调用详情' })
    trigger.focus(); fireEvent.click(trigger)
    expect(screen.getByText('执行 ID')).toBeTruthy()
    expect(screen.getByText('plan-run')).toBeTruthy()
    expect(screen.getByText('thread-1')).toBeTruthy()
    expect(screen.getByText('最近一次 token 用量')).toBeTruthy()
    expect(screen.getByText('Runtime 未提供')).toBeTruthy()
    expect(screen.queryByText('应用记录的本轮指令')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '本轮指令（应用记录）' }))
    expect(screen.getByText('应用记录的本轮指令')).toBeTruthy()
    expect((await screen.findByLabelText('执行检查器')).textContent).toContain('plan-run')
    fireEvent.click(trigger)
    expect(screen.queryByText('执行 ID')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
  it('keeps public streamed response in place, hides action JSON and preserves manual reading position', () => {
    const { task, run } = fixture()
    task.messages = [{ id: 'reply', role: 'assistant', runId: run.id, text: '先检查', streaming: true, createdAt: '' }]
    const view = render(<GoalAssistantRunDetails task={task} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '调用详情' }))
    const area = screen.getByLabelText('本轮模型回复')
    const body = area.querySelector('.markdown-body')
    Object.defineProperties(area, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 240 } })
    area.scrollTop = 250; fireEvent.scroll(area); area.focus()
    const next = { ...task, messages: [{ ...task.messages[0], text: '先检查适用条件。\n\n```goalward\n{"proposals":[]}' }] }
    view.rerender(<GoalAssistantRunDetails task={next} run={run} />)
    expect(area.querySelector('.markdown-body')).toBe(body)
    expect(area.textContent).toBe('先检查适用条件。')
    expect(area.scrollTop).toBe(250)
    expect(document.activeElement).toBe(area)
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(area.scrollTop).toBe(1500)
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull()
  })
  it.each(['completed', 'failed', 'stopped'] as const)('removes active loading on %s and retains the partial reply and run record', status => {
    const { task, run, event } = fixture()
    task.messages = [{ id: 'reply', role: 'assistant', runId: run.id, text: '保留已收到的内容', createdAt: '' }]
    const onStop = vi.fn(async () => {})
    const view = render(<GoalAssistantRunDetails task={task} run={run} onStop={onStop} />)
    expect(view.container.querySelector('[data-slot=spinner]')).toBeTruthy()
    const terminal = { ...run, members: run.members.map(member => ({ ...member, status })) }
    const next = { ...task, runs: [terminal], events: [event({}, status)] }
    view.rerender(<GoalAssistantRunDetails task={next} run={terminal} onStop={onStop} />)
    expect(view.container.querySelector('[data-slot=spinner]')).toBeNull()
    expect(screen.queryByRole('button', { name: '停止生成建议' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '调用详情' }))
    expect(screen.getByText('保留已收到的内容')).toBeTruthy()
    expect(screen.getByText('plan-run')).toBeTruthy()
  })
  it('calls stop immediately and exposes a failed stop while retaining current progress', async () => {
    const { task, run } = fixture()
    let reject!: (cause: Error) => void
    const onStop = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    render(<GoalAssistantRunDetails task={task} run={run} onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: '停止生成建议' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('正在停止…')
    await act(async () => reject(new Error('停止请求失败')))
    expect(screen.getByRole('alert').textContent).toContain('停止请求失败')
    expect((screen.getByRole('button', { name: '停止生成建议' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('restores only its validated assistant history and provides retry on restoration failure', async () => {
    const { task, run } = fixture()
    const onPrepare = vi.fn().mockRejectedValueOnce(new Error('记录加载失败')).mockResolvedValueOnce(undefined)
    render(<GoalAssistantRunDetails task={{ ...task, historyPending: true }} run={run} onPrepare={onPrepare} />)
    expect(onPrepare).toHaveBeenCalledWith(task.id)
    expect(screen.getByRole('status').textContent).toBe('正在恢复调用记录…')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('记录加载失败'))
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2))
  })
  it('does not render or prepare a foreign run', () => {
    const { task, run } = fixture()
    const onPrepare = vi.fn(async () => {})
    const view = render(<GoalAssistantRunDetails task={{ ...task, goalId: 'foreign-goal', historyPending: true }} run={run} onPrepare={onPrepare} />)
    expect(view.container.innerHTML).toBe('')
    expect(onPrepare).not.toHaveBeenCalled()
  })
  it('does not move an old stop error into a later invocation', async () => {
    const { task, run } = fixture()
    let reject!: (cause: Error) => void
    const onStop = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    const view = render(<GoalAssistantRunDetails task={task} run={run} onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: '停止生成建议' }))
    const nextRun = { ...run, id: 'next-run' }
    view.rerender(<GoalAssistantRunDetails task={{ ...task, runs: [...task.runs, nextRun] }} run={nextRun} onStop={onStop} />)
    await act(async () => reject(new Error('旧调用停止失败')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).not.toBe('正在停止…')
  })
  it('ticks elapsed time only while running and stops at the persisted terminal event', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T01:00:05Z'))
    const { task, run, event } = fixture()
    const view = render(<GoalAssistantRunDetails task={task} run={run} />)
    expect(semanticText(screen.getByTitle('本次调用耗时'))).toBe('00:05')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(semanticText(screen.getByTitle('本次调用耗时'))).toBe('00:07')
    const completed = { ...run, members: run.members.map(member => ({ ...member, status: 'completed' as const })) }
    view.rerender(<GoalAssistantRunDetails task={{ ...task, runs: [completed], events: [{ ...event({}, 'completed'), timestamp: '2026-10-12T01:00:06Z' }] }} run={completed} />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(semanticText(screen.getByTitle('本次调用耗时'))).toBe('00:06')
  })
  it('separates requested turn reasoning, native session defaults and latest reported token evidence', () => {
    const { task, run, event } = fixture()
    task.events = [event({ type: 'codex.app_server.thread_ready', threadId: 'thread-1', model: 'confirmed-model', modelProvider: 'openai', reasoningEffort: 'medium' }), event({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }), event({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, total: { totalTokens: 99 } } } })]
    render(<GoalAssistantRunDetails task={task} run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '调用详情' }))
    const detail = screen.getByLabelText('目标助手模型调用')
    expect(within(detail).getByText('请求模型').nextElementSibling?.textContent).toBe('saved-model')
    expect(within(detail).getByText('Runtime 确认模型').nextElementSibling?.textContent).toBe('confirmed-model')
    expect(within(detail).getByText('本轮思考强度').nextElementSibling?.textContent).toBe('high')
    expect(within(detail).getByText('会话默认思考强度').nextElementSibling?.textContent).toBe('medium')
    const turn = within(detail).getByText('最近一次 token 用量').parentElement!
    expect(semanticText(turn)).toContain('15')
    expect(semanticText(turn)).not.toContain('99')
    expect(semanticText(within(detail).getByText('会话累计 token 用量').parentElement!)).toContain('99')
  })
})
