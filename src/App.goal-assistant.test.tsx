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

const bridge = vi.hoisted(() => ({ isDesktop: true, loadState: vi.fn(), saveState: vi.fn(), loadTaskHistory: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(), ensureGoalAssistantDirectory: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))
vi.mock('@/components/GoalsPage', () => ({ GoalsPage: ({ state, selectedGoalId, onSendAssistant, onStopAssistant, onOpenTask, onViewChange, viewRequest }: GoalsPageProps) => {
  const goal = state.goals.find(item => item.id === selectedGoalId) ?? state.goals[0]
  const [error, setError] = useState('')
  const tab = viewRequest?.tab ?? 'tasks'
  useEffect(() => { if (goal) onViewChange?.(goal.id, tab) }, [goal?.id, tab])
  return <section aria-label="目标调度测试">
    <span data-testid="goal-context">{goal?.id}:{tab}</span>
    <button onClick={() => void onSendAssistant?.(goal.id, '我想改善这个流程', 'clarify', 'codex').catch(cause => setError(String(cause)))}>发送目标澄清</button>
    <button onClick={() => void onSendAssistant?.(goal.id, '根据目标整理任务', 'plan', 'codex').catch(cause => setError(String(cause)))}>发送任务提议</button>
    <button onClick={() => void onStopAssistant?.(goal.id)}>停止目标助手</button>
    {state.tasks.filter(item => item.kind !== 'goal_assistant' && item.goalId === goal?.id).map(item => <button key={item.id} onClick={() => onOpenTask(item.id)}>目标内打开：{item.title}</button>)}
    {error && <span role="alert">{error}</span>}
  </section>
} }))
vi.mock('@/components/Workbench', () => ({ Workbench: ({ task, onGoal, onGoalProgress }: { task: Task; onGoal: () => void; onGoalProgress: () => void }) => <section aria-label="任务执行工作台"><span>{task.title}</span><div>{task.messages.map(message => <span key={message.id}>{message.text}</span>)}</div><button onClick={onGoal}>返回所属目标</button><button onClick={onGoalProgress}>检查目标条件</button></section> }))

let stored: AppState, emit: (event: RuntimeEvent) => void
const draft: GoalAssistantDraft = { title: '优化产品流程', intent: '减少操作负担', expected: '试用者能顺利完成主流程', constraints: '只处理主流程', deadline: '2026-10-30', currentSummary: '流程尚未验收', criteria: [{ text: '主流程试用', baseline: '尚未验收', target: '约定流程全部通过试用', method: '保存试用记录' }] }
const proposal = { id: 'inspect', title: '调查当前流程', delivery: '流程与问题清单', acceptance: '覆盖所有关键步骤并标出未知', deadline: '2026-10-20', dependsOn: [] }
const block = (action: unknown) => `可读的目标助手回复。\n\n\`\`\`goalward\n${JSON.stringify(action)}\n\`\`\``

beforeEach(() => {
  vi.resetAllMocks()
  stored = createInitialState()
  const goal = createGoal({ title: '改善产品' })
  stored.goals = [goal]
  stored = confirmGoalAssistantDraft(stored, goal.id, draft)
  stored.activeGoalId = goal.id
  stored.tasks = [createWorkspaceTask(stored.settings, { title: '实际执行任务', goalId: goal.id, directory: '/user/project', acceptance: '由人验收' })]
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
async function mount() { render(<App />); await screen.findByRole('region', { name: '目标调度测试' }) }
async function dispatch(label = '发送任务提议') {
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
  return bridge.startRun.mock.calls[0][0] as StartRequest
}
async function event(request: StartRequest, kind: RuntimeEvent['kind'], text = '') {
  await act(async () => emit({ id: crypto.randomUUID(), taskId: request.taskId, runId: request.runId, memberId: request.memberId, timestamp: new Date().toISOString(), kind, text, exitCode: kind === 'completed' ? 0 : undefined }))
}
async function reply(request: StartRequest, text: string) { await event(request, 'stdout', `${JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } })}\n`) }

describe('Goal assistant native dispatch integration', () => {
  it('dispatches a hidden durable Task in the app directory and restricts only its Runtime snapshot', async () => {
    const activeId = stored.activeTaskId
    stored.settings.runtimes[0].args = ['--dangerously-bypass-approvals-and-sandbox']
    stored.settings.runtimes[0].permissions = { codex: { sandbox: 'danger-full-access', network: 'allow', additionalDirectories: ['/user/project'] } }
    const settings = structuredClone(stored.settings)
    await mount()
    const request = await dispatch('发送目标澄清')
    const assistant = stored.tasks.find(item => item.id === request.taskId)!
    expect(assistant).toMatchObject({ kind: 'goal_assistant', goalId: stored.goals[0].id, mode: 'solo' })
    expect(request.directory).toBe(`/app-data/goal-assistant-workspaces/${stored.goals[0].id}`)
    expect(request.runtime.permissions?.codex).toEqual({ sandbox: 'read-only', network: 'inherit', additionalDirectories: [] })
    expect(request.runtime.args).toEqual([])
    expect(request.prompt).toContain('不得修改用户项目')
    expect(stored.activeTaskId).toBe(activeId)
    expect(stored.settings).toEqual(settings)
    expect(assistant.runs[0].context?.goal?.assistant?.requestPhase).toBe('clarify')
    const navigation = screen.getByRole('navigation', { name: '工作空间导航' })
    expect(within(navigation.querySelector('.task-list') as HTMLElement).queryByText(assistant.title)).toBeNull()
    fireEvent.click(within(navigation).getByRole('button', { name: /^任务\s*1$/ }))
    const list = await screen.findByRole('complementary', { name: '任务列表' })
    expect(within(list).queryByRole('button', { name: `打开任务：${assistant.title}` })).toBeNull()
    expect(within(list).getByRole('button', { name: '打开任务：实际执行任务' })).toBeTruthy()
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
    expect(stored.tasks.find(item => item.id === request.taskId)!.messages.some(item => item.text.includes('可读的目标助手回复'))).toBe(true)
  })

  it('recovers assistant history before continuing and preserves older immutable Run snapshots', async () => {
    const goal = stored.goals[0], assistant = createGoalAssistantTask(stored.settings, { goalId: goal.id, directory: '/app-data/old' })
    const member = assistant.members[0]
    assistant.runs = [{ id: 'old-run', prompt: '旧轮澄清', createdAt: '2026-10-09T00:00:00Z', directory: '/app-data/old', members: [{ ...member, runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' }] }]
    assistant.messages = [{ id: 'old-chat', role: 'assistant', text: '已保存的澄清历史', createdAt: assistant.runs[0].createdAt, runId: 'old-run' }]
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
    expect(continued.messages.find(item => item.id === 'old-chat')?.text).toBe('已保存的澄清历史')
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
    const run = { id: 'completed-before-reopen', createdAt: '2026-10-09T00:00:00Z', directory: assistant.directory, prompt: '已保存的拆分请求', context: captureRunContext(stored, assistant), members: [{ ...assistant.members[0], runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' as const }] }
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
    business.messages = [{ id: 'business-history', role: 'user', text: '必须保留的业务对话', createdAt: '2026-10-10T00:00:00Z' }]
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
    const goalA = stored.goals[0], goalB = createGoal({ ...draft, title: '目标 B 的私有计划', currentSummary: '目标 B 的现状' })
    const assistantB = createGoalAssistantTask(stored.settings, { goalId: goalB.id, directory: '/app-data/goal-b-private' })
    goalB.assistant = { taskId: assistantB.id, requestPhase: 'plan' }
    stored.goals.push(goalB)
    stored.tasks[0].historyPending = true // Keep unrelated business history lazy on startup.
    stored.tasks.push(assistantB)
    const runB = { id: 'goal-b-completed', createdAt: '2026-10-09T00:00:00Z', directory: assistantB.directory, prompt: '只属于 B 的拆分', context: captureRunContext(stored, assistantB), members: [{ ...assistantB.members[0], runtime: structuredClone(stored.settings.runtimes[0]), model: '', status: 'completed' as const }] }
    assistantB.runs = [runB]
    assistantB.messages = [{ id: 'goal-b-chat', role: 'assistant', text: block({ type: 'plan', baseGoalVersion: goalB.version, proposals: [{ ...proposal, title: 'B 的私有任务建议' }] }), createdAt: runB.createdAt, runId: runB.id }]
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
    expect(request.directory).toBe(`/app-data/goal-assistant-workspaces/${goalA.id}`)
    expect(request.prompt).not.toContain('B 的私有任务建议')
    expect(stored.goals[1]).toEqual(protectedGoalB)
    expect(stored.tasks.find(task => task.id === assistantB.id)).toEqual(protectedTaskB)
    expect(bridge.loadTaskHistory).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
    expect(stored.activeTaskId).toBe(businessId)
  })

  it('opens the linked business Task with its own conversation and returns to the original Goal task context', async () => {
    const goal = stored.goals[0], business = stored.tasks[0]
    business.messages = [{ id: 'business-chat', role: 'user', text: '业务任务的独立对话', createdAt: '2026-10-10T00:00:00Z' }]
    const assistant = createGoalAssistantTask(stored.settings, { goalId: goal.id, directory: '/app-data/private' })
    assistant.messages = [{ id: 'assistant-chat', role: 'user', text: '只属于目标助手的对话', createdAt: '2026-10-10T00:00:00Z' }]
    stored.tasks.push(assistant)
    stored.goals[0].assistant = { ...goal.assistant, taskId: assistant.id }
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '目标内打开：实际执行任务' }))
    const workbench = await screen.findByRole('region', { name: '任务执行工作台' })
    expect(within(workbench).getByText('业务任务的独立对话')).toBeTruthy()
    expect(within(workbench).queryByText('只属于目标助手的对话')).toBeNull()
    await waitFor(() => expect(stored.activeTaskId).toBe(business.id))
    expect(screen.getByText('优化产品流程', { selector: '.task-owner-filter span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回所属目标' }))
    await waitFor(() => expect(screen.getByTestId('goal-context').textContent).toBe(`${goal.id}:tasks`))
    expect(stored.activeGoalId).toBe(goal.id)
  })
})
