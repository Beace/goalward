import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal } from './goals'
import { createGoalAssistantTask } from './goal-assistant'
import { captureRunContext } from './workspace'
import { getGoalAssistantInvocations, getGoalAssistantRun, getGoalAssistantRunResponse } from './goal-assistant-execution'
import type { Run, RuntimeEvent } from './types'

function fixture() {
  const state = createInitialState()
  const goal = createGoal({ title: 'Improve material' })
  goal.assistant = { requestPhase: 'plan' }
  const task = createGoalAssistantTask(state.settings, { goalId: goal.id, directory: '/app/assistant' })
  state.goals = [goal]
  const run: Run = { id: 'plan-run', createdAt: '2026-10-12T01:00:00Z', directory: task.directory, prompt: 'Confirmed goal', context: captureRunContext(state, task), members: [{ ...task.members[0], runtime: state.settings.runtimes[0], model: 'saved-model', effectiveReasoningEffort: 'high', status: 'running', sessionId: 'thread-1' }] }
  task.runs = [run]
  const event = (payload: unknown, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ id: `event-${task.events.length}`, kind: 'stdout', taskId: task.id, runId: run.id, memberId: run.members[0].id, timestamp: run.createdAt, text: `${JSON.stringify(payload)}\n`, ...overrides })
  const append = (payload: unknown, overrides: Partial<RuntimeEvent> = {}) => { task.events.push(event(payload, overrides)) }
  return { state, task, goal, run, event, append }
}

describe('Goal assistant run selection', () => {
  it('uses the latest request snapshot and rejects cross-goal or business tasks', () => {
    const { task, goal, run } = fixture()
    expect(getGoalAssistantRun(task, goal.id)).toBe(run)
    expect(getGoalAssistantRun(undefined, goal.id)).toBeUndefined()
    expect(getGoalAssistantRun(task, 'other')).toBeUndefined()
    expect(getGoalAssistantRun({ ...task, kind: undefined }, goal.id)).toBeUndefined()
    expect(getGoalAssistantRun({ ...task, runs: [{ ...run, context: undefined }] }, goal.id)).toBeUndefined()
    expect(getGoalAssistantRun({ ...task, runs: [{ ...run, context: { ...run.context!, goal: { ...goal, id: 'other' } } }] }, goal.id)).toBeUndefined()
  })
  it('does not display old planning progress after a later clarification request', () => {
    const { task, goal, run } = fixture()
    const clarify = { ...run, id: 'clarify-run', context: { ...run.context!, goal: { ...goal, assistant: { requestPhase: 'clarify' as const } } } }
    task.runs.push(clarify)
    expect(getGoalAssistantRun(task, goal.id)).toBeUndefined()
    expect(getGoalAssistantRun(task, goal.id, 'clarify')).toBe(clarify)
  })
})

describe('Native invocation evidence', () => {
  it('shows Claude native init/message model and result usage without inventing conversation totals', () => {
    const { task, run, append } = fixture()
    run.members[0].runtime = { ...run.members[0].runtime, adapter: 'claude' }
    append({ type: 'system', subtype: 'init', session_id: 'thread-1', model: 'native-alias' })
    append({ type: 'assistant', session_id: 'thread-1', message: { role: 'assistant', model: 'native-claude', usage: { input_tokens: 20, output_tokens: 2 } } })
    append({ type: 'result', session_id: 'thread-1', usage: { input_tokens: 42, cache_read_input_tokens: 30, output_tokens: 11 } })
    append({ type: 'result', session_id: 'other-session', usage: { output_tokens: 9999 } })
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ nativeModel: 'native-claude', latestUsage: { input: 42, cachedInput: 30, output: 11 } })
    expect(getGoalAssistantInvocations(task, run)[0].conversationUsage).toBeUndefined()
    expect(getGoalAssistantInvocations(task, run)[0].nativeProvider).toBeUndefined()
  })
  it('shows Pi confirmed session model and actual assistant message usage', () => {
    const { task, run, append } = fixture()
    run.members[0].runtime = { ...run.members[0].runtime, adapter: 'pi' }
    append({ type: 'runtime.session_ready', sessionId: 'other-session', model: { id: 'foreign-model', provider: 'foreign-provider' } })
    expect(getGoalAssistantInvocations(task, run)[0].nativeModel).toBeUndefined()
    append({ type: 'runtime.session_ready', sessionId: 'thread-1', model: { id: 'pi-model', provider: 'pi-provider' }, reasoningEffort: 'medium' })
    append({ type: 'message_end', message: { role: 'assistant', model: 'pi-actual', provider: 'pi-provider', usage: { input: 10, cacheRead: 5, output: 7, totalTokens: 22 } } })
    append({ type: 'message_end', message: { role: 'toolResult', usage: { output: 999 } } })
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ nativeModel: 'pi-actual', nativeProvider: 'pi-provider', nativeSessionReasoning: 'medium', latestUsage: { input: 10, cachedInput: 5, output: 7, total: 22 } })
    expect(getGoalAssistantInvocations(task, run)[0].conversationUsage).toBeUndefined()
  })
  it('keeps requested snapshot and confirmed session configuration separate', () => {
    const { state, task, run, append } = fixture()
    append({ type: 'codex.app_server.thread_ready', threadId: 'thread-1', model: 'native-model', modelProvider: 'openai', reasoningEffort: 'medium' })
    state.settings.runtimes[0] = { ...state.settings.runtimes[0], name: 'changed-setting' }
    const result = getGoalAssistantInvocations(task, run)[0]
    expect(result).toMatchObject({ threadId: 'thread-1', nativeModel: 'native-model', nativeProvider: 'openai', nativeSessionReasoning: 'medium' })
    expect(result.member.model).toBe('saved-model')
    expect(result.member.effectiveReasoningEffort).toBe('high')
    expect(result.member.runtime.name).not.toBe('changed-setting')
    expect(result.latestUsage).toBeUndefined()
  })
  it('reconstructs split native frames before reading metadata', () => {
    const { task, run, event } = fixture()
    const content = JSON.stringify({ type: 'codex.app_server.thread_ready', threadId: 'thread-1', model: 'confirmed', modelProvider: null, reasoningEffort: null })
    task.events = [event({}, { id: 'chunk-a', text: content.slice(0, 41) }), event({}, { id: 'chunk-b', text: content.slice(41) + '\n' })]
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ nativeModel: 'confirmed', nativeProvider: undefined, nativeSessionReasoning: undefined })
  })
  it('uses last for the latest reported increment and total for cumulative conversation usage', () => {
    const { task, run, append } = fixture()
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    append({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 27 }, total: { inputTokens: 80, outputTokens: 19, totalTokens: 99 }, modelContextWindow: 128000 } } })
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ turnId: 'turn-1', latestUsage: { input: 20, cachedInput: 10, output: 7, reasoningOutput: 3, total: 27 }, conversationUsage: { input: 80, output: 19, total: 99 }, modelContextWindow: 128000 })
  })
  it('rejects events from another task, run, member, thread or turn', () => {
    const { task, run, append } = fixture()
    const ready = { type: 'codex.app_server.thread_ready', threadId: 'thread-1', model: 'foreign-model' }
    append(ready, { taskId: 'other-task' }); append(ready, { runId: 'other-run' }); append(ready, { memberId: 'other-member' })
    append({ ...ready, threadId: 'other-thread' })
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    for (const [threadId, turnId] of [['other-thread', 'turn-1'], ['thread-1', 'other-turn']]) append({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { totalTokens: 123 }, total: { totalTokens: 200 } } } })
    const result = getGoalAssistantInvocations(task, run)[0]
    expect(result.nativeModel).toBeUndefined()
    expect(result.latestUsage).toBeUndefined()
    expect(result.conversationUsage).toBeUndefined()
  })
  it('does not guess latest usage from an uncorrelated turn or conversation totals', () => {
    const { task, run, append } = fixture()
    append({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { totalTokens: 100 } } } })
    expect(getGoalAssistantInvocations(task, run)[0].latestUsage).toBeUndefined()
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    append({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: { totalTokens: 1000 }, last: { inputTokens: -10, outputTokens: '4', totalTokens: Infinity } } } })
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ latestUsage: undefined, conversationUsage: { total: 1000 } })
  })
  it('clears previous usage when a new native turn starts within this run', () => {
    const { task, run, append } = fixture()
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    append({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { totalTokens: 23 } } } })
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } })
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ turnId: 'turn-2', latestUsage: undefined })
  })
  it('retains reported usage when the same turn start is repeated', () => {
    const { task, run, append } = fixture()
    const start = { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }
    append(start)
    append({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { totalTokens: 23 }, total: { totalTokens: 91 }, modelContextWindow: 128000 } } })
    append(start)
    expect(getGoalAssistantInvocations(task, run)[0]).toMatchObject({ turnId: 'turn-1', latestUsage: { total: 23 }, conversationUsage: { total: 91 }, modelContextWindow: 128000 })
  })
  it('updates the confirmed model only when rerouting matches this thread and turn', () => {
    const { task, run, append } = fixture()
    append({ type: 'codex.app_server.thread_ready', threadId: 'thread-1', model: 'original-model' })
    append({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    append({ method: 'model/rerouted', params: { threadId: 'other-thread', turnId: 'turn-1', toModel: 'foreign-model' } })
    append({ method: 'model/rerouted', params: { threadId: 'thread-1', turnId: 'old-turn', toModel: 'old-model' } })
    expect(getGoalAssistantInvocations(task, run)[0].nativeModel).toBe('original-model')
    append({ method: 'model/rerouted', params: { threadId: 'thread-1', turnId: 'turn-1', fromModel: 'original-model', toModel: 'rerouted-model', reason: 'availability' } })
    const result = getGoalAssistantInvocations(task, run)[0]
    expect(result.nativeModel).toBe('rerouted-model')
    expect(result.member.model).toBe('saved-model')
  })
})

describe('Planning response scope', () => {
  it('shows stable public partial prose while withholding reasoning and internal action JSON', () => {
    const { task, run } = fixture()
    task.messages = [
      { id: 'old', role: 'assistant', text: 'Previous turn reply', runId: 'other-run', createdAt: '' },
      { id: 'reasoning', role: 'assistant', kind: 'reasoning', text: 'Internal reasoning', runId: run.id, createdAt: '' },
      { id: 'foreign', role: 'assistant', memberId: 'other-member', text: 'Other member', runId: run.id, createdAt: '' },
      { id: 'reply', role: 'assistant', text: 'Investigate conditions first.\n\n```go', streaming: true, runId: run.id, createdAt: '' },
    ]
    expect(getGoalAssistantRunResponse(task, run)).toBe('Investigate conditions first.')
    task.messages[3].text += 'alward\n{"proposals":[]}\n```'
    expect(getGoalAssistantRunResponse(task, run)).toBe('Investigate conditions first.')
  })
})
