// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalAssistant, GoalTaskProposals } from './GoalAssistant'
import { GoalsPage } from './GoalsPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { confirmGoalAssistantDraft, createGoalAssistantTask } from '@/lib/goal-assistant'
import { captureRunContext, createWorkspaceTask } from '@/lib/workspace'
import type { AppState } from '@/lib/types'
import type { GoalAssistantDraft } from '@/lib/goal-types'

vi.mock('@/lib/bridge', () => ({ isDesktop: true, ensureGoalAssistantDirectory: vi.fn(async (id: string) => `/app/goals/${id}`) }))
vi.mock('./MarkdownMessage', () => ({ MarkdownMessage: ({ text }: { text: string }) => <div>{text}</div> }))
vi.mock('./RuntimeApprovalPanel', () => ({ RuntimeApprovalPanel: ({ task }: { task: { id: string } }) => <div aria-label="Assistant approval source">{task.id}</div> }))
vi.mock('./GoalCelebration', () => ({ GoalCelebration: ({ onDismiss }: { onDismiss: () => void }) => <div role="status">Goal confirmed<button onClick={onDismiss}>Dismiss goal confirmation</button></div> }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const draft: GoalAssistantDraft = {
  title: 'Complete the team knowledge base pilot', intent: 'Improve access to material', expected: 'The team can independently find pilot material', constraints: 'Handle public projects only', deadline: '2026-11-01', currentSummary: 'Existing document inventory',
  criteria: [{ text: 'Pilot material is discoverable', baseline: 'Pending verification', target: 'Three colleagues can find the agreed material', method: 'Record independent trial results' }],
}
function seed(): AppState {
  const state = createInitialState()
  const goal = createGoal({ title: 'Organize the material' })
  goal.assistant = { draft: structuredClone(draft), input: 'Add this constraint' }
  return { ...state, tasks: [], goals: [goal], agents: [], activeGoalId: goal.id }
}

async function selectDate(trigger: HTMLElement, value: string) {
  fireEvent.click(trigger)
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day).toLocaleDateString('zh-CN')
  const button = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`[data-slot="calendar"] button[data-day="${date}"]`)
    expect(button).toBeTruthy()
    return button!
  })
  fireEvent.click(button)
  await waitFor(() => expect(document.querySelector('[data-slot="calendar"]')).toBeNull())
}

describe('Goal assistant live conversation', () => {
  function runningState() {
    const state = seed(), goal = state.goals[0]
    const task = createGoalAssistantTask(state.settings, { goalId: goal.id, directory: '/app/assistant' })
    task.runs = [{ id: 'live-run', createdAt: '', prompt: '', directory: task.directory, members: [{ ...task.members[0], runtime: state.settings.runtimes[0], model: '', status: 'running' }] }]
    task.messages = [{ id: 'user', role: 'user', text: 'I want to improve this workflow', createdAt: '', runId: 'live-run' }]
    state.tasks = [task]; goal.assistant!.taskId = task.id
    return state
  }
  const props = { onStart: vi.fn(), onConfirm: vi.fn(), onChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn() }
  it('shows native tool activity and expandable model details in the goal conversation', async () => {
    const state = runningState(), task = state.tasks[0], run = task.runs[0]
    run.context = captureRunContext(state, task)
    run.members[0].sessionId = 'goal-thread'
    task.events = [{ id: 'native-tool', taskId: task.id, runId: run.id, memberId: run.members[0].id, timestamp: '2026-10-13T00:00:00Z', kind: 'stdout', text: JSON.stringify({ type: 'codex.app_server.item', threadId: 'goal-thread', turnId: 'goal-turn', eventType: 'item.started', item: { id: 'read-reference', type: 'mcpToolCall', server: 'workspace', tool: 'read', status: 'inProgress', arguments: { path: '/app/assistant/reference.md' } } }) + '\n' }]
    render(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    const details = screen.getByLabelText('目标助手模型调用')
    expect(within(details).getByRole('status').textContent).toBe('正在执行工具')
    fireEvent.click(within(details).getByRole('button', { name: '调用详情' }))
    await waitFor(() => expect(within(details).getByText('会话 ID')).toBeTruthy())
    expect(within(details).getByText('goal-thread')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '给目标助手的消息' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止目标助手' })).toBeTruthy()
  })
  it.each(['completed', 'failed', 'stopped'] as const)('updates one message in place before completion and clears loading on %s', status => {
    let state = runningState()
    const view = render(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    const transcript = view.container.querySelector('.goal-assistant-transcript')!
    expect(within(transcript as HTMLElement).getByRole('status').textContent).toBe('正在思考…')
    expect(transcript.querySelector('[data-slot=spinner]')).toBeTruthy()
    const stop = screen.getByRole('button', { name: '停止目标助手' }); stop.focus()
    const append = (text: string) => {
      state = { ...state, tasks: [{ ...state.tasks[0], messages: [state.tasks[0].messages[0], { id: 'reply', role: 'assistant', text, createdAt: '', runId: 'live-run', streaming: true }] }] }
      view.rerender(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    }
    append('Define ')
    const article = transcript.querySelector('.goal-assistant-message-assistant')!
    expect(article.textContent).toContain('Define')
    expect(within(transcript as HTMLElement).getByRole('status').textContent).toBe('正在回复…')
    append('Define success criteria first.\n\n```go')
    expect(transcript.querySelector('.goal-assistant-message-assistant')).toBe(article)
    expect(article.textContent).toContain('Define success criteria first.')
    expect(article.textContent).not.toContain('```go')
    expect(document.activeElement).toBe(stop)
    append('Define success criteria first.\n\n```goalward\n{"draft":null}\n```')
    expect(article.textContent).not.toContain('draft')
    state = { ...state, tasks: [{ ...state.tasks[0], runs: [{ ...state.tasks[0].runs[0], members: [{ ...state.tasks[0].runs[0].members[0], status }] }] }] }
    view.rerender(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    expect(transcript.querySelector('[data-slot=spinner]')).toBeNull()
    expect(article.textContent).toContain('Define success criteria first.')
    if (status !== 'completed') expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
  it('shows a pending reply immediately during dispatch and retains input on failure', async () => {
    const state = seed()
    let reject!: (error: Error) => void
    const onSend = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    const view = render(<GoalAssistant {...props} state={state} goal={state.goals[0]} onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: '发送给目标助手' }))
    const transcript = view.container.querySelector('.goal-assistant-transcript') as HTMLElement
    expect(within(transcript).getByRole('status').textContent).toBe('正在连接目标助手…')
    await act(async () => reject(new Error('Connection failed')))
    expect(transcript.querySelector('[data-slot=spinner]')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Connection failed')
    expect((screen.getByLabelText('给目标助手的消息') as HTMLTextAreaElement).value).toBe('Add this constraint')
  })
  it('preserves the reading position during streaming and supports jumping back to the latest reply', () => {
    let state = runningState()
    const view = render(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    const transcript = view.container.querySelector('.goal-assistant-transcript') as HTMLElement
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1800 }, clientHeight: { configurable: true, value: 500 } })
    transcript.scrollTop = 300; fireEvent.scroll(transcript)
    state = { ...state, tasks: [{ ...state.tasks[0], messages: [...state.tasks[0].messages, { id: 'reply', role: 'assistant', text: 'Incrementally received reply', createdAt: '', runId: 'live-run', streaming: true }] }] }
    view.rerender(<GoalAssistant {...props} state={state} goal={state.goals[0]} />)
    expect(transcript.scrollTop).toBe(300)
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(transcript.scrollTop).toBe(1800)
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull()
  })
})

describe('Task proposal execution progress', () => {
  function planningState() {
    const state = seed(), goal = state.goals[0]
    const task = createGoalAssistantTask(state.settings, { goalId: goal.id, directory: '/app/assistant' })
    goal.assistant = { ...goal.assistant, taskId: task.id, requestPhase: 'plan' }
    state.tasks = [task]
    task.runs = [{ id: 'planning-run', createdAt: new Date().toISOString(), prompt: 'Current planning instructions', directory: task.directory, context: captureRunContext(state, task), members: [{ ...task.members[0], runtime: state.settings.runtimes[0], model: 'plan-model', status: 'running' }] }]
    return state
  }
  it('shows a scoped planning run in the task tab and stops that assistant immediately', async () => {
    const state = planningState(), stop = vi.fn(async () => {})
    render(<GoalTaskProposals state={state} goal={state.goals[0]} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onStop={stop} />)
    expect(screen.getByRole('button', { name: /调用详情/ })).toBeTruthy()
    expect(screen.getByText(/Codex · plan-model/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /停止/ }))
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
  })
  it('does not show an earlier planning run when a newer clarification is active', () => {
    const state = planningState(), task = state.tasks[0]
    task.runs[0].members[0].status = 'completed'
    state.goals[0].assistant!.requestPhase = 'clarify'
    task.runs.push({ ...task.runs[0], id: 'new-clarification', context: captureRunContext(state, task), members: [{ ...task.runs[0].members[0], status: 'running' }] })
    render(<GoalTaskProposals state={state} goal={state.goals[0]} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /调用详情/ })).toBeNull()
    expect(screen.getByText('目标助手正在对话，请等待本轮结束后再整理任务建议。')).toBeTruthy()
  })
  it('keeps planning launch visible before a run exists and clears it on failure', async () => {
    const initial = seed()
    let latest = initial, reject!: (error: Error) => void
    const send = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '目标助手' }))
    fireEvent.click(screen.getByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(screen.getByText('正在启动任务建议…')).toBeTruthy()
    expect((screen.getByRole('button', { name: '重新提议' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => reject(new Error('Planning startup failed')))
    expect(screen.queryByText('正在启动任务建议…')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Planning startup failed')
    expect(latest.goals[0].assistant!.confirmedVersion).toBe(latest.goals[0].version)
  })
  it('restores planning history, blocks adoption while pending, and exposes recovery retry after failure', async () => {
    const state = planningState()
    state.tasks[0].historyPending = true
    state.goals[0].assistant!.proposals = [{ id: 'p', title: 'Task retained by the user', delivery: 'Result', acceptance: 'Acceptance', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: state.goals[0].version }]
    const prepare = vi.fn().mockRejectedValueOnce(new Error('Planning history restoration failed')).mockResolvedValueOnce(undefined)
    render(<GoalTaskProposals state={state} goal={state.goals[0]} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onPrepare={prepare} onRetry={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Planning history restoration failed'))
    expect(prepare).toHaveBeenCalledWith(state.tasks[0].id)
    expect((screen.getByRole('button', { name: '采用' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '重新提议' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重试恢复历史' }))
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
    expect(state.goals[0].assistant!.proposals![0].title).toBe('Task retained by the user')
  })
  it('keeps model completion distinct from publishing validated task proposals', () => {
    const state = planningState()
    state.tasks[0].runs[0].members[0].status = 'completed'
    const view = render(<GoalTaskProposals state={state} goal={state.goals[0]} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.getByText('模型回复已完成，正在核对任务建议…')).toBeTruthy()
    state.goals[0].assistant = { ...state.goals[0].assistant, processedRunId: 'planning-run', error: '结构化任务建议格式无效' }
    view.rerender(<GoalTaskProposals state={state} goal={state.goals[0]} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} />)
    expect(screen.queryByText('模型回复已完成，正在核对任务建议…')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('结构化任务建议格式无效')
    expect(screen.getByRole('button', { name: /调用详情/ })).toBeTruthy()
  })
})

describe('Goal assistant boundaries', () => {
  it('persists a new exploration across Goal navigation and clears it only with the saved Goal', async () => {
    const initial = seed()
    initial.goalExplorationInput = 'Unsubmitted idea'
    let latest = initial
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} explorationRequest={1} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect((screen.getByLabelText('给目标助手的消息') as HTMLTextAreaElement).value).toBe('Unsubmitted idea')
    fireEvent.change(screen.getByLabelText('给目标助手的消息'), { target: { value: 'New unfinished exploration' } })
    await waitFor(() => expect(latest.goalExplorationInput).toBe('New unfinished exploration'))
    fireEvent.click(screen.getByRole('button', { name: '打开目标：Organize the material' }))
    fireEvent.click(screen.getByRole('button', { name: '开始一件事' }))
    expect((screen.getByLabelText('给目标助手的消息') as HTMLTextAreaElement).value).toBe('New unfinished exploration')
    fireEvent.click(screen.getByRole('button', { name: '开始整理目标' }))
    await waitFor(() => expect(latest.goals).toHaveLength(2))
    expect(latest.goalExplorationInput).toBe('')
    expect(latest.goals[0].assistant!.draft).toEqual(draft)
    expect(latest.goals[1].status).toBe('clarifying')
    expect(latest.tasks).toHaveLength(0)
  })

  it('keeps Goal conversation and persisted input separate from business Task messages', async () => {
    const initial = seed()
    const assistant = createWorkspaceTask(initial.settings, { title: 'Goal assistant', goalId: initial.goals[0].id })
    assistant.kind = 'goal_assistant'
    assistant.messages = [{ id: 'a', role: 'assistant', text: 'Reply belongs only to the goal\n```goalward\n{"draft":null}\n```', createdAt: '' }]
    const business = createWorkspaceTask(initial.settings, { title: 'Business task', goalId: initial.goals[0].id })
    business.messages = [{ id: 'b', role: 'user', text: 'Business conversation must not appear in the goal assistant', createdAt: '' }]
    initial.tasks = [business, assistant]
    initial.goals[0].assistant!.taskId = assistant.id
    let latest = initial
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalAssistant state={state} goal={state.goals[0]} onStart={vi.fn()} onConfirm={vi.fn()} onSend={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect(screen.getByText('Reply belongs only to the goal')).toBeTruthy()
    expect(screen.queryByText('Business conversation must not appear in the goal assistant')).toBeNull()
    expect(screen.queryByText('{"draft":null}')).toBeNull()
    fireEvent.change(screen.getByLabelText('给目标助手的消息'), { target: { value: 'Retain the new goal draft' } })
    await waitFor(() => expect(latest.goals[0].assistant!.input).toBe('Retain the new goal draft'))
    expect(latest.tasks.find(task => task.id === business.id)!.messages[0].text).toBe('Business conversation must not appear in the goal assistant')
  })

  it.each(['business', 'other-goal'] as const)('ignores a damaged assistant reference pointing at %s history, approval, and running state', type => {
    const initial = seed(), goal = initial.goals[0]
    const foreign = createWorkspaceTask(initial.settings, { title: 'Conversation that must remain private', goalId: goal.id })
    if (type === 'other-goal') { foreign.kind = 'goal_assistant'; foreign.goalId = 'another-goal' }
    foreign.messages = [{ id: 'private', role: 'assistant', text: 'Private reply from another task', createdAt: '' }]
    foreign.historyPending = true
    foreign.runs = [{ id: 'private-run', createdAt: '', prompt: '', directory: '', members: [{ ...foreign.members[0], runtime: initial.settings.runtimes[0], model: '', status: 'running' }] }]
    initial.tasks = [foreign]
    goal.assistant!.taskId = foreign.id
    goal.assistant!.proposals = [{ id: 'p1', title: 'Business task awaiting adoption', delivery: 'Result', acceptance: 'Acceptance', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version }]
    const prepare = vi.fn()
    render(<><GoalAssistant state={initial} goal={goal} onStart={vi.fn()} onConfirm={vi.fn()} onChange={vi.fn()} onPrepare={prepare} onStop={vi.fn()} /><GoalTaskProposals state={initial} goal={goal} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} /></>)
    expect(screen.queryByText('Private reply from another task')).toBeNull()
    expect(screen.queryByLabelText('Assistant approval source')).toBeNull()
    expect(screen.queryByRole('button', { name: '停止目标助手' })).toBeNull()
    expect(screen.queryByText('目标助手正在处理…')).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '确认目标并安排任务' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '采用' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('uses the current formal definition after manual Goal and context revisions, then confirms without restoring the old draft', async () => {
    const initial = seed()
    let latest = confirmGoalAssistantDraft(initial, initial.goals[0].id)
    const send = vi.fn(async () => {})
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '修订' }))
    const definition = screen.getByRole('dialog')
    fireEvent.change(within(definition).getByLabelText('目标名称'), { target: { value: 'Current formal goal' } })
    fireEvent.change(within(definition).getByLabelText('预期结果'), { target: { value: 'Current formal result' } })
    await selectDate(within(definition).getByLabelText('期望日期（可选）'), '2026-11-03')
    fireEvent.change(within(definition).getByLabelText('本次修订原因'), { target: { value: 'Manually check the latest requirements' } })
    fireEvent.click(within(definition).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '更新现状' }))
    const context = screen.getByRole('dialog')
    fireEvent.change(within(context).getByLabelText('整体描述'), { target: { value: 'Current state just added manually' } })
    fireEvent.change(within(context).getByLabelText('变化原因'), { target: { value: 'New evidence' } })
    fireEvent.click(within(context).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '目标助手' }))
    expect((screen.getByLabelText('目标名称') as HTMLInputElement).value).toBe('Current formal goal')
    expect((screen.getByLabelText('预期结果') as HTMLTextAreaElement).value).toBe('Current formal result')
    expect(screen.getByLabelText('期望日期（可选）').textContent).toBe('2026年11月3日')
    expect((screen.getByLabelText('当前现状') as HTMLTextAreaElement).value).toBe('Current state just added manually')
    fireEvent.change(screen.getByLabelText('范围与约束'), { target: { value: 'Constraints just revised by the user' } })
    await waitFor(() => expect(latest.goals[0].assistant!.draftGoalVersion).toBe(latest.goals[0].version))
    expect(latest.goals[0].assistant!.draftStateVersion).toBe(latest.goals[0].currentState.version)
    fireEvent.click(screen.getByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(latest.goals[0]).toMatchObject({ title: 'Current formal goal', expected: 'Current formal result', deadline: '2026-11-03', constraints: 'Constraints just revised by the user' })
    expect(latest.goals[0].currentState.summary).toBe('Current state just added manually')
  })

  it.each(['goal', 'context'] as const)('refuses a draft edit if its displayed %s version changed before the write', async kind => {
    const initial = seed()
    let latest = structuredClone(initial)
    if (kind === 'goal') latest.goals[0].version += 1
    else latest.goals[0].currentState.version += 1
    const previousDraft = structuredClone(latest.goals[0].assistant!.draft)
    render(<GoalAssistant state={initial} goal={initial.goals[0]} onStart={vi.fn()} onConfirm={vi.fn()} onChange={async reducer => { latest = reducer(latest) }} />)
    fireEvent.change(screen.getByLabelText('目标名称'), { target: { value: 'Old view edits that must not overwrite the current data' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目标或现状已更新'))
    expect(latest.goals[0].assistant!.draft).toEqual(previousDraft)
  })

  it('preserves detailed criteria and acceptance when the overview editor only changes a name or date', async () => {
    let latest = seed()
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    latest.goals[0].criteria[0] = { ...latest.goals[0].criteria[0], status: 'satisfied', evidence: 'Colleague trial records' }
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '修订' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: 'Renamed knowledge base pilot' } })
    await selectDate(within(dialog).getByLabelText('期望日期（可选）'), '2026-11-02')
    fireEvent.change(within(dialog).getByLabelText('本次修订原因'), { target: { value: 'Change the name and date' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(latest.goals[0].title).toBe('Renamed knowledge base pilot'))
    expect(latest.goals[0].criteria[0]).toMatchObject({ ...draft.criteria[0], status: 'satisfied', evidence: 'Colleague trial records' })
  })

  it('reads back the exact standard and verification method when opening a criterion from its progress chart', () => {
    const initial = seed()
    const state = confirmGoalAssistantDraft(initial, initial.goals[0].id)
    render(<GoalsPage state={state} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} />)
    expect(screen.queryByText(draft.criteria[0].target)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pilot material is discoverable：待验证' }))
    const dialog = screen.getByRole('dialog', { name: '检查成功条件' })
    expect(within(dialog).getByText(draft.criteria[0].target)).toBeTruthy()
    expect(within(dialog).getByText(draft.criteria[0].method)).toBeTruthy()
    expect(within(dialog.querySelector('dl')!).getByText(draft.criteria[0].baseline)).toBeTruthy()
    expect(within(dialog).getByLabelText('验收依据')).toBeTruthy()
  })

  it('commits confirmation before celebration and automatic plan, and preserves a confirmed goal when plan fails', async () => {
    const initial = seed()
    let latest = initial
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => { throw new Error('Runtime startup failed') })
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} selectedGoalId={initial.goals[0].id} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => { await gate; latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    expect(screen.queryByText('Goal confirmed')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(screen.getByText('Goal confirmed')).toBeTruthy())
    await waitFor(() => expect(send).toHaveBeenCalledWith(initial.goals[0].id, expect.any(String), 'plan', expect.any(String)))
    expect(latest.goals[0].status).toBe('active')
    expect(latest.tasks).toHaveLength(0)
    expect(screen.getByRole('tab', { name: '任务 0' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Runtime startup failed')
    expect(screen.getByRole('button', { name: '重新提议' })).toBeTruthy()
    cleanup()
    render(<GoalsPage state={latest} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} />)
    expect(screen.queryByText('Goal confirmed')).toBeNull()
  })

  it('does not celebrate or dispatch a plan when confirmation persistence fails', async () => {
    const initial = seed(), send = vi.fn()
    render(<GoalsPage state={initial} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async () => { throw new Error('Save failed') }} />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Save failed'))
    expect(screen.queryByText('Goal confirmed')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect((screen.getByLabelText('预期结果') as HTMLTextAreaElement).value).toBe(draft.expected)
  })

  it('rolls back an optimistic failed confirmation so retry must commit before it can plan', async () => {
    const initial = seed(), send = vi.fn(async () => {})
    let latest = initial, failNext = true
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => {
        latest = reducer(latest); setState(latest)
        if (failNext) { failNext = false; throw new Error('First persistence failed') }
      }} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('First persistence failed'))
    expect(latest.goals[0].assistant!.confirmedVersion).toBeUndefined()
    expect(latest.goals[0].version).toBe(initial.goals[0].version)
    expect(screen.queryByText('Goal confirmed')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(latest.goals[0].assistant!.confirmedVersion).toBe(latest.goals[0].version)
  })

  it('keeps suggestions outside business Tasks until adoption and allows prerequisite adoption together', async () => {
    let latest = seed()
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    const goal = latest.goals[0]
    goal.assistant!.proposals = [
      { id: 'p1', title: 'Organize checklist', delivery: 'Readable document inventory', acceptance: 'Includes pilot material', deadline: '2026-10-20', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
      { id: 'p2', title: 'Colleague trial', delivery: 'Trial records', acceptance: 'Record material discovery results', deadline: '2026-10-30', dependsOn: ['p1'], status: 'suggested', baseGoalVersion: goal.version },
    ]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect(latest.tasks).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: '采用' })[1])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('先采用前置任务'))
    expect(latest.tasks).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('任务建议名称：p1'), { target: { value: 'Checklist task revised by the user' } })
    expect(latest.goals[0].assistant!.proposals![0].edited).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '采用全部 2' }))
    await waitFor(() => expect(latest.tasks).toHaveLength(2))
    const first = latest.tasks.find(task => task.title === 'Checklist task revised by the user')!
    expect(latest.tasks.find(task => task.title === 'Colleague trial')!.dependencies).toEqual([first.id])
    expect(latest.tasks.every(task => !task.runs.length)).toBe(true)
    expect(screen.queryByRole('button', { name: '采用全部 2' })).toBeNull()
  })

  it('rolls back optimistic adoption failure and retry creates one durable Task', async () => {
    let latest = seed(), failNext = true
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    latest.goals[0].assistant!.proposals = [{ id: 'p1', title: 'Checklist task', delivery: 'Readable checklist', acceptance: 'Contains pilot material', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: latest.goals[0].version }]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => {
        latest = reducer(latest); setState(latest)
        if (failNext) { failNext = false; throw new Error('Adoption save failed') }
      }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '采用' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Adoption save failed'))
    expect(latest.tasks).toHaveLength(0)
    expect(latest.goals[0].assistant!.proposals![0].status).toBe('suggested')
    fireEvent.click(screen.getByRole('button', { name: '采用' }))
    await waitFor(() => expect(latest.tasks).toHaveLength(1))
    expect(latest.goals[0].assistant!.proposals![0].taskId).toBe(latest.tasks[0].id)
    expect(screen.getByText('已采用')).toBeTruthy()
  })

  it('marks manual dependency changes so subsequent plan generation can preserve the edited suggestion', async () => {
    let latest = seed()
    const goal = latest.goals[0]
    goal.assistant!.proposals = [
      { id: 'p1', title: 'Upstream task', delivery: 'Upstream result', acceptance: 'Upstream acceptance', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
      { id: 'p2', title: 'Downstream task', delivery: 'Downstream result', acceptance: 'Downstream acceptance', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
    ]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getAllByRole('button', { name: '交付、验收与依赖' })[1])
    fireEvent.click(await screen.findByRole('checkbox', { name: '依赖：Downstream task → Upstream task' }))
    await waitFor(() => expect(latest.goals[0].assistant!.proposals![1]).toMatchObject({ edited: true, dependsOn: ['p1'] }))
    expect(latest.goals[0].assistant!.proposals![0].edited).toBeUndefined()
  })
})
