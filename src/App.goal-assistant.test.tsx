// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import { createGoal } from './lib/goals'
import { confirmGoalAssistantDraft, createGoalAssistantTask } from './lib/goal-assistant'
import * as goalAssistant from './lib/goal-assistant'
import { captureRunContext, createWorkspaceTask } from './lib/workspace'
import type { AppState, RuntimeEvent, StartRequest, Task } from './lib/types'
import type { GoalAssistantDraft } from './lib/goal-types'
import type { GoalsPageProps } from './components/GoalsPage'

const bridge = vi.hoisted(() => ({ isDesktop: true, activeRuntimeTurns: vi.fn(async () => []), loadState: vi.fn(), saveState: vi.fn(), loadTaskHistory: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(), ensureGoalAssistantDirectory: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))
vi.mock('@/components/GoalsPage', () => ({ GoalsPage: ({ state, selectedGoalId, onSendAssistant, onStopAssistant, onOpenTask, onViewChange, viewRequest }: GoalsPageProps) => {
  const goal = state.goals.find(item => item.id === selectedGoalId) ?? state.goals[0]
  const assistant = state.tasks.find(item => item.id === goal?.assistant?.taskId && item.kind === 'goal_assistant' && item.goalId === goal.id)
  const [error, setError] = useState('')
  const tab = viewRequest?.tab ?? 'tasks'
  useEffect(() => { if (goal) onViewChange?.(goal.id, tab) }, [goal?.id, tab])
  return <section aria-label="Goal dispatch test">
    <span data-testid="goal-context">{goal?.id}:{tab}</span>
    <button onClick={() => void onSendAssistant?.(goal.id, 'I want to improve this workflow', 'clarify', 'codex').catch(cause => setError(String(cause)))}>Send goal clarification</button>
    <button onClick={() => void onSendAssistant?.(goal.id, 'Organize tasks for this goal', 'plan', 'codex').catch(cause => setError(String(cause)))}>Send task proposal</button>
    <button onClick={() => void onStopAssistant?.(goal.id)}>Stop goal assistant</button>
    <div aria-label="Goal assistant messages">{assistant?.messages.filter(message => message.role === 'assistant' && message.kind !== 'reasoning').map(message => <span key={message.id} data-streaming={Boolean(message.streaming)}>{message.text}</span>)}</div>
    {state.tasks.filter(item => item.kind !== 'goal_assistant' && item.goalId === goal?.id).map(item => <button key={item.id} onClick={() => onOpenTask(item.id)}>Open within goal: {item.title}</button>)}
    {error && <span role="alert">{error}</span>}
  </section>
} }))
vi.mock('@/components/Workbench', () => ({ Workbench: ({ task, onGoal, onGoalProgress, onSend }: { task: Task; onGoal: () => void; onGoalProgress: () => void; onSend: (prompt: string, recipient: string) => Promise<void> }) => <section aria-label="Task workbench"><span>{task.title}</span><div>{task.messages.map(message => <span key={message.id}>{message.text}</span>)}</div><button onClick={onGoal}>Return to parent goal</button><button onClick={onGoalProgress}>Check goal criteria</button><button onClick={() => void onSend('Run business task', 'all')}>Send business task</button></section> }))

let stored: AppState, emit: (event: RuntimeEvent) => void
const draft: GoalAssistantDraft = { title: 'Improve product workflow', intent: 'Reduce interaction burden', expected: 'Trial users can complete the main workflow', constraints: 'Handle the main workflow only', deadline: '2026-10-30', currentSummary: 'Workflow not accepted yet', criteria: [{ text: 'Main workflow trial', baseline: 'Not accepted yet', target: 'The agreed workflow passes the trial', method: 'Save trial records' }] }
const proposal = { id: 'inspect', title: 'Investigate the current workflow', delivery: 'Workflow and issue inventory', acceptance: 'Cover all key steps and identify unknowns', deadline: '2026-10-20', dependsOn: [] }
const block = (action: unknown) => `Readable goal assistant reply。\n\n\`\`\`goalward\n${JSON.stringify(action)}\n\`\`\``

beforeEach(() => {
  vi.resetAllMocks()
  stored = createInitialState()
  const goal = createGoal({ title: 'Improve product' })
  goal.workingDirectories = ['/user/project']
  stored.goals = [goal]
  stored = confirmGoalAssistantDraft(stored, goal.id, draft)
  stored.activeGoalId = goal.id
  stored.tasks = [createWorkspaceTask(stored.settings, { title: 'Actual execution task', goalId: goal.id, directory: '/user/project', acceptance: 'Human acceptance' })]
  stored.activeTaskId = stored.tasks[0].id
  stored.onboarding = { version: 1, completedAt: '2026-10-10T00:00:00Z', outcome: 'configured' }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (value: AppState) => { stored = structuredClone(value) })
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.loadTaskHistory.mockResolvedValue([])
  bridge.onRuntimeEvent.mockImplementation(async (callback: typeof emit) => { emit = callback; return () => {} })
  bridge.ensureGoalAssistantDirectory.mockImplementation(async (id: string) => `/app-data/goal-assistant-workspaces/${id}`)
  bridge.startRun.mockResolvedValue(undefined)
  bridge.stopRun.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function mount() { render(<App />); await screen.findByRole('region', { name: 'Goal dispatch test' }) }
async function dispatch(label = 'Send task proposal') {
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
  return bridge.startRun.mock.calls[0][0] as StartRequest
}
async function event(request: StartRequest, kind: RuntimeEvent['kind'], text = '') {
  await act(async () => emit({ id: crypto.randomUUID(), taskId: request.taskId, runId: request.runId, memberId: request.memberId, timestamp: new Date().toISOString(), kind, text, exitCode: kind === 'completed' ? 0 : undefined }))
}
async function reply(request: StartRequest, text: string) { await event(request, 'stdout', `${JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } })}\n`) }
async function snapshot(request: StartRequest, type: 'item.started' | 'item.updated' | 'item.completed', text: string) {
  await event(request, 'stdout', `${JSON.stringify({ type, item: { id: 'answer', type: 'agent_message', text } })}\n`)
}
const deltaFrame = (request: StartRequest, delta: string) => `${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'assistant-thread', turnId: request.runId, itemId: 'answer', delta } })}\n`
async function delta(request: StartRequest, text: string) { await event(request, 'stdout', deltaFrame(request, text)) }

describe('Goal assistant native dispatch integration', () => {
  it('dispatches a hidden durable Task in the fixed goal workspace and restricts only its Runtime snapshot', async () => {
    const activeId = stored.activeTaskId
    stored.settings.runtimes[0].args = ['--dangerously-bypass-approvals-and-sandbox']
    stored.settings.runtimes[0].permissions = { codex: { sandbox: 'danger-full-access', network: 'allow', additionalDirectories: ['/user/project'] } }
    const settings = structuredClone(stored.settings)
    await mount()
    const request = await dispatch('Send goal clarification')
    const assistant = stored.tasks.find(item => item.id === request.taskId)!
    expect(assistant).toMatchObject({ kind: 'goal_assistant', goalId: stored.goals[0].id, mode: 'solo' })
    expect(request.directory).toBe('/user/project')
    expect(stored.goals[0].workingDirectories).toEqual(['/user/project'])
    expect(request.runtime.permissions?.codex).toEqual({ sandbox: 'read-only', network: 'inherit', additionalDirectories: [] })
    expect(request.runtime.args).toEqual([])
    expect(request).toMatchObject({ codexStreaming: true })
    expect(request.prompt).toContain('Do not modify the user project')
    expect(stored.activeTaskId).toBe(activeId)
    expect(stored.settings).toEqual(settings)
    expect(assistant.runs[0].context?.goal?.assistant?.requestPhase).toBe('clarify')
    const navigation = screen.getByRole('navigation', { name: '工作空间导航' })
    expect(within(navigation.querySelector('.task-list') as HTMLElement).queryByText(assistant.title)).toBeNull()
    fireEvent.click(within(navigation).getByRole('button', { name: /^任务\s*1$/ }))
    const list = await screen.findByRole('complementary', { name: '任务列表' })
    expect(within(list).queryByRole('button', { name: `打开任务：${assistant.title}` })).toBeNull()
    expect(within(list).getByRole('button', { name: '打开任务：Actual execution task' })).toBeTruthy()
  })

  it('keeps business Task dispatch on its existing execution transport', async () => {
    const businessId = stored.tasks[0].id
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open within goal: Actual execution task' }))
    await screen.findByRole('region', { name: 'Task workbench' })
    fireEvent.click(screen.getByRole('button', { name: 'Send business task' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    const request = bridge.startRun.mock.calls[0][0] as StartRequest
    expect(request.taskId).toBe(businessId)
    expect(request).not.toMatchObject({ codexStreaming: true })
    expect(request.directory).toBe('/user/project')
  })

  it.each(['clarify', 'plan'] as const)('projects %s response deltas immediately and publishes structured suggestions only after successful completion', async phase => {
    await mount()
    const request = await dispatch(phase === 'clarify' ? 'Send goal clarification' : 'Send task proposal')
    const goalBeforeReply = structuredClone(stored.goals[0])
    const nextDraft = { ...draft, title: 'New goal from the streaming reply' }
    const fullReply = block(phase === 'clarify'
      ? { type: phase, baseGoalVersion: goalBeforeReply.version, draft: nextDraft }
      : { type: phase, baseGoalVersion: goalBeforeReply.version, proposals: [proposal] })
    await snapshot(request, 'item.started', '')
    const firstFrame = deltaFrame(request, 'Readable goal')
    await event(request, 'stdout', firstFrame.slice(0, -4))
    expect(screen.getByLabelText('Goal assistant messages').textContent).toBe('')
    await event(request, 'stdout', firstFrame.slice(-4))
    const transcript = screen.getByLabelText('Goal assistant messages')
    expect(within(transcript).getByText('Readable goal').getAttribute('data-streaming')).toBe('true')
    let messages = stored.tasks.find(item => item.id === request.taskId)!.messages.filter(message => message.role === 'assistant')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: 'Readable goal', streaming: true })
    expect(stored.goals[0].assistant?.draft).toEqual(goalBeforeReply.assistant?.draft)
    expect(stored.goals[0].assistant?.proposals).toEqual(goalBeforeReply.assistant?.proposals)

    await delta(request, fullReply.slice('Readable goal'.length))
    messages = stored.tasks.find(item => item.id === request.taskId)!.messages.filter(message => message.role === 'assistant')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: fullReply, streaming: true })
    expect(stored.goals[0].assistant?.draft).toEqual(goalBeforeReply.assistant?.draft)
    expect(stored.goals[0].assistant?.proposals).toEqual(goalBeforeReply.assistant?.proposals)

    await snapshot(request, 'item.completed', fullReply)
    expect(stored.goals[0].assistant?.processedRunId).toBeUndefined()
    expect(stored.goals[0].assistant?.draft).toEqual(goalBeforeReply.assistant?.draft)
    expect(stored.goals[0].assistant?.proposals).toEqual(goalBeforeReply.assistant?.proposals)
    await event(request, 'completed')
    await waitFor(() => expect(stored.goals[0].assistant?.processedRunId).toBe(request.runId))
    if (phase === 'clarify') expect(stored.goals[0].assistant?.draft).toEqual(nextDraft)
    else expect(stored.goals[0].assistant?.proposals?.[0]).toMatchObject({ ...proposal, status: 'suggested' })
    expect(stored.tasks.find(item => item.id === request.taskId)!.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  })

  it('retains a stopped partial stream without publishing a goal draft or task proposals', async () => {
    await mount()
    const request = await dispatch('Send goal clarification')
    const goalBeforeReply = structuredClone(stored.goals[0])
    await delta(request, 'Start ')
    await delta(request, 'with your existing conditions')
    expect(within(screen.getByLabelText('Goal assistant messages')).getByText('Start with your existing conditions').getAttribute('data-streaming')).toBe('true')
    await event(request, 'stopped')
    await waitFor(() => expect(stored.tasks.find(item => item.id === request.taskId)!.runs[0].members[0].status).toBe('stopped'))
    const messages = stored.tasks.find(item => item.id === request.taskId)!.messages.filter(message => message.role === 'assistant')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: 'Start with your existing conditions', streaming: false })
    expect(within(screen.getByLabelText('Goal assistant messages')).getByText('Start with your existing conditions').getAttribute('data-streaming')).toBe('false')
    expect(stored.goals[0].assistant?.draft).toEqual(goalBeforeReply.assistant?.draft)
    expect(stored.goals[0].assistant?.proposals).toEqual(goalBeforeReply.assistant?.proposals)
    expect(stored.goals[0].assistant?.processedRunId).toBeUndefined()
  })

  it('waits for successful process completion, then publishes suggestions once without adopting or achieving them', async () => {
    await mount()
    const request = await dispatch(), version = stored.goals[0].version
    const source = structuredClone(stored.tasks.find(item => item.id === request.taskId)!.runs[0].context)
    await reply(request, block({ type: 'plan', baseGoalVersion: version, proposals: [proposal] }))
    expect(stored.goals[0].assistant?.proposals).toBeUndefined()
    await event(request, 'completed')
    await waitFor(() => expect(stored.goals[0].assistant?.processedRunId).toBe(request.runId))
    expect(stored.goals[0].assistant?.proposals?.[0]).toEqual({ ...proposal, status: 'suggested', baseGoalVersion: version })
    expect(stored.goals[0].criteria[0].status).toBe('unverified')
    expect(stored.goals[0].status).toBe('active')
    expect(stored.tasks.filter(item => item.kind !== 'goal_assistant')).toHaveLength(1)
    expect(stored.tasks.find(item => item.id === request.taskId)!.runs[0].context).toEqual(source)
    await event(request, 'completed')
    expect(stored.goals[0].assistant?.proposals).toHaveLength(1)
  })

  it.each(['failed', 'stopped'] as const)('retains readable output but does not publish a %s Run as suggestions', async kind => {
    await mount()
    const request = await dispatch()
    await reply(request, block({ type: 'plan', baseGoalVersion: stored.goals[0].version, proposals: [proposal] }))
    await event(request, kind)
    await waitFor(() => expect(stored.tasks.find(item => item.id === request.taskId)!.runs[0].members[0].status).toBe(kind))
    expect(stored.goals[0].assistant?.proposals).toBeUndefined()
    expect(stored.goals[0].assistant?.processedRunId).toBeUndefined()
    expect(stored.tasks.find(item => item.id === request.taskId)!.messages.some(item => item.text.includes('Readable goal assistant reply'))).toBe(true)
  })

  it('recovers assistant history before continuing and preserves older immutable Run snapshots', async () => {
    const goal = stored.goals[0], assistant = createGoalAssistantTask(stored.settings, { goalId: goal.id, directory: '/app-data/old' })
    const member = assistant.members[0]
    assistant.runs = [{ id: 'old-run', prompt: 'Previous turn clarification', createdAt: '2026-10-09T00:00:00Z', directory: '/app-data/old', members: [{ ...member, runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' }] }]
    assistant.messages = [{ id: 'old-chat', role: 'assistant', text: 'Saved clarification history', createdAt: assistant.runs[0].createdAt, runId: 'old-run' }]
    assistant.historyPending = true
    stored.tasks.push(assistant)
    stored.goals[0].assistant = { ...goal.assistant, taskId: assistant.id }
    const oldRun = structuredClone(assistant.runs[0])
    await mount()
    const request = await dispatch()
    expect(bridge.loadTaskHistory).toHaveBeenCalledWith(assistant.id, expect.any(AbortSignal))
    const continued = stored.tasks.find(item => item.id === assistant.id)!
    expect(request.taskId).toBe(assistant.id)
    expect(continued.historyPending).toBeUndefined()
    expect(continued.messages.find(item => item.id === 'old-chat')?.text).toBe('Saved clarification history')
    expect(continued.runs[0]).toEqual(oldRun)
    expect(continued.runs).toHaveLength(2)
  })

  it('hydrates an unprocessed completed assistant reply on reopen without opening it or loading business histories', async () => {
    const goal = stored.goals[0], assistant = createGoalAssistantTask(stored.settings, { goalId: goal.id, directory: '/app-data/private' })
    stored.goals[0] = { ...goal, assistant: { ...goal.assistant, taskId: assistant.id, requestPhase: 'plan' } }
    stored.tasks[0].historyPending = true
    const businessId = stored.tasks[0].id
    assistant.historyPending = true
    stored.tasks.push(assistant)
    const run = { id: 'completed-before-reopen', createdAt: '2026-10-09T00:00:00Z', directory: assistant.directory, prompt: 'Saved decomposition request', context: captureRunContext(stored, assistant), members: [{ ...assistant.members[0], runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' as const }] }
    assistant.runs = [run]
    const history: RuntimeEvent[] = [
      { id: 'saved-reply', taskId: assistant.id, runId: run.id, memberId: assistant.members[0].id, timestamp: '2026-10-09T00:00:01Z', kind: 'stdout', text: `${JSON.stringify({ type: 'item.completed', item: { id: 'saved-answer', type: 'agent_message', text: block({ type: 'plan', baseGoalVersion: goal.version, proposals: [proposal] }) } })}\n` },
      { id: 'saved-completed', taskId: assistant.id, runId: run.id, memberId: assistant.members[0].id, timestamp: '2026-10-09T00:00:02Z', kind: 'completed', text: 'completed', exitCode: 0 },
    ]
    bridge.loadTaskHistory.mockImplementation(async (taskId: string) => { if (taskId !== assistant.id) throw new Error('business history must stay lazy'); return history })
    await mount()
    await waitFor(() => expect(stored.goals[0].assistant?.processedRunId).toBe(run.id))
    expect(stored.goals[0].assistant?.proposals?.[0]).toMatchObject({ ...proposal, status: 'suggested' })
    expect(bridge.loadTaskHistory).toHaveBeenCalledTimes(1)
    expect(bridge.loadTaskHistory.mock.calls[0][0]).toBe(assistant.id)
    expect(stored.tasks.find(task => task.id === businessId)?.historyPending).toBe(true)
    expect(stored.activeTaskId).toBe(businessId)
    expect(bridge.startRun).not.toHaveBeenCalled()
  })

  it('creates a new assistant for a corrupted business Task reference without changing its workspace or chat', async () => {
    const business = stored.tasks[0]
    business.messages = [{ id: 'business-history', role: 'user', text: 'Business conversation that must be retained', createdAt: '2026-10-10T00:00:00Z' }]
    stored.goals[0].assistant = { ...stored.goals[0].assistant, taskId: business.id }
    const original = structuredClone(business)
    await mount()
    const request = await dispatch()
    expect(request.taskId).not.toBe(business.id)
    expect(stored.goals[0].assistant?.taskId).toBe(request.taskId)
    expect(stored.tasks.find(item => item.id === business.id)).toEqual(original)
    expect(stored.tasks.find(item => item.id === request.taskId)?.kind).toBe('goal_assistant')
    expect(request.runtime.permissions?.codex?.sandbox).toBe('read-only')
    expect(stored.activeTaskId).toBe(business.id)
  })

  it.each([true, false])('isolates a cross-Goal completed assistant reference with historyPending=%s', async historyPending => {
    const goalA = stored.goals[0], goalB = createGoal({ ...draft, title: 'Private plan for goal B', currentSummary: 'Current state of goal B' })
    goalB.workingDirectories = ['/app-data/goal-b-private']
    const assistantB = createGoalAssistantTask(stored.settings, { goalId: goalB.id, directory: '/app-data/goal-b-private' })
    goalB.assistant = { taskId: assistantB.id, requestPhase: 'plan' }
    stored.goals.push(goalB)
    stored.tasks[0].historyPending = true // Keep unrelated business history lazy on startup.
    stored.tasks.push(assistantB)
    const runB = { id: 'goal-b-completed', createdAt: '2026-10-09T00:00:00Z', directory: assistantB.directory, prompt: 'Decomposition belonging only to B', context: captureRunContext(stored, assistantB), members: [{ ...assistantB.members[0], runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' as const }] }
    assistantB.runs = [runB]
    assistantB.messages = [{ id: 'goal-b-chat', role: 'assistant', text: block({ type: 'plan', baseGoalVersion: goalB.version, proposals: [{ ...proposal, title: 'Private task proposal for B' }] }), createdAt: runB.createdAt, runId: runB.id }]
    assistantB.historyPending = historyPending || undefined
    stored.goals[1] = { ...goalB, assistant: { ...goalB.assistant, requestPhase: undefined, processedRunId: runB.id } }
    stored.goals[0] = { ...goalA, assistant: { ...goalA.assistant, taskId: assistantB.id, requestPhase: 'plan' } }
    const protectedGoalB = structuredClone(stored.goals[1]), protectedTaskB = structuredClone(assistantB), businessId = stored.activeTaskId
    const process = vi.spyOn(goalAssistant, 'processGoalAssistantRun')
    await mount()
    await act(async () => { await Promise.resolve() })
    expect(process).not.toHaveBeenCalled()
    expect(bridge.loadTaskHistory).not.toHaveBeenCalled()
    expect(bridge.loadTraceEvents).not.toHaveBeenCalled()
    expect(stored.goals[0].assistant).toMatchObject({ taskId: assistantB.id, requestPhase: 'plan' })
    expect(stored.goals[0].assistant?.processedRunId).toBeUndefined()
    expect(stored.goals[0].assistant?.proposals).toBeUndefined()
    expect(stored.goals[0].assistant?.error).toBeUndefined()
    const request = await dispatch()
    expect(request.taskId).not.toBe(assistantB.id)
    expect(stored.goals[0].assistant?.taskId).toBe(request.taskId)
    expect(stored.tasks.find(task => task.id === request.taskId)).toMatchObject({ kind: 'goal_assistant', goalId: goalA.id })
    expect(request.directory).toBe('/user/project')
    expect(request.prompt).not.toContain('Private task proposal for B')
    expect(stored.goals[1]).toEqual(protectedGoalB)
    expect(stored.tasks.find(task => task.id === assistantB.id)).toEqual(protectedTaskB)
    expect(bridge.loadTaskHistory).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
    expect(stored.activeTaskId).toBe(businessId)
  })

  it('opens the linked business Task with its own conversation and returns to the original Goal task context', async () => {
    const goal = stored.goals[0], business = stored.tasks[0]
    business.messages = [{ id: 'business-chat', role: 'user', text: 'Independent business task conversation', createdAt: '2026-10-10T00:00:00Z' }]
    const assistant = createGoalAssistantTask(stored.settings, { goalId: goal.id, directory: '/app-data/private' })
    assistant.messages = [{ id: 'assistant-chat', role: 'user', text: 'Conversation belonging only to the goal assistant', createdAt: '2026-10-10T00:00:00Z' }]
    stored.tasks.push(assistant)
    stored.goals[0].assistant = { ...goal.assistant, taskId: assistant.id }
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Open within goal: Actual execution task' }))
    const workbench = await screen.findByRole('region', { name: 'Task workbench' })
    expect(within(workbench).getByText('Independent business task conversation')).toBeTruthy()
    expect(within(workbench).queryByText('Conversation belonging only to the goal assistant')).toBeNull()
    await waitFor(() => expect(stored.activeTaskId).toBe(business.id))
    expect(screen.getByText('Improve product workflow', { selector: '.task-owner-filter span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Return to parent goal' }))
    await waitFor(() => expect(screen.getByTestId('goal-context').textContent).toBe(`${goal.id}:tasks`))
    expect(stored.activeGoalId).toBe(goal.id)
  })
})
