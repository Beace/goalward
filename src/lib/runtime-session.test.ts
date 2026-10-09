import { describe, expect, it } from 'vitest'
import { applyRuntimeEvent, buildPrompt, createInitialState, createTask, recoverInterruptedState } from './domain'
import { reusableSession } from './runtime-session'
import type { Adapter, RuntimeEvent } from './types'

function fixture(adapter: Adapter = 'kimi') {
  const state = createInitialState()
  const runtime = { ...state.settings.runtimes.find(r => r.adapter === adapter)!, enabled: true }
  const task = createTask(state.settings, 'session continuity', '/tmp/project', 'solo')
  const member = { ...task.members[0], runtimeId: runtime.id }
  task.members = [member]
  task.runs = [{ id: 'first', createdAt: task.createdAt, directory: task.directory, prompt: 'first', members: [{ ...member, runtime, model: '', status: 'running' }] }]
  state.tasks = [task]
  const event = (text: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ id: crypto.randomUUID(), taskId: task.id, runId: 'first', memberId: member.id, timestamp: task.createdAt, kind: 'stdout', text, ...overrides })
  return { state, task, member, runtime, event }
}

describe('task-scoped native session continuity', () => {
  it.each([
    ['kimi', { type: 'kimi.session', sessionId: 'native-session' }],
    ['codex', { type: 'thread.started', thread_id: 'native-session' }],
    ['claude', { type: 'system', subtype: 'init', session_id: 'native-session' }],
  ] as const)('captures split %s protocol frames, persists and recovers the native id', (adapter, payload) => {
    const { state, task, member, runtime, event } = fixture(adapter)
    const frame = JSON.stringify(payload) + '\n'
    const first = applyRuntimeEvent(state, event(frame.slice(0, 17)))
    const next = applyRuntimeEvent(first, event(frame.slice(17)))
    expect(task.runs[0].members[0].sessionId).toBeUndefined()
    expect(next.tasks[0].runs[0].members[0].sessionId).toBe('native-session')
    expect(next.tasks[0].messages).toHaveLength(0)
    const saved = JSON.parse(JSON.stringify(next))
    expect(reusableSession(saved.tasks[0], member, runtime)).toBe('native-session')
    delete saved.tasks[0].runs[0].members[0].sessionId
    expect(recoverInterruptedState(saved).tasks[0].runs[0].members[0].sessionId).toBe('native-session')
  })

  it('keeps the session when model, effort or permissions change', () => {
    const { task, member, runtime } = fixture()
    task.runs[0].members[0].sessionId = 'same-session'
    task.directory += '/'
    expect(reusableSession(task, { ...member, modelId: 'other-model', reasoningEffort: 'high' }, { ...runtime, defaultModel: 'other-model' })).toBe('same-session')
  })

  it('isolates runtime identity, executable, launch configuration, directories, tasks and members', () => {
    const { task, member, runtime } = fixture()
    task.runs[0].members[0].sessionId = 'private-session'
    for (const changed of [{ ...runtime, id: 'other' }, { ...runtime, executable: '/other/kimi' }, { ...runtime, args: ['--config', 'other'] }]) expect(reusableSession(task, member, changed)).toBeUndefined()
    expect(reusableSession({ ...task, directory: '/tmp/elsewhere' }, member, runtime)).toBeUndefined()
    expect(reusableSession({ ...task, runs: [], events: [] }, member, runtime)).toBeUndefined()
    expect(reusableSession(task, { ...member, id: 'another-member' }, runtime)).toBeUndefined()
    expect(reusableSession(task, member, { ...runtime, adapter: 'generic' })).toBeUndefined()
  })

  it('does not resume an old session through a later runtime switch or legacy turn', () => {
    const { task, member, runtime, event } = fixture()
    task.runs[0].members[0].sessionId = 'old-session'
    const later = { ...task.runs[0], id: 'later', members: [{ ...task.runs[0].members[0], sessionId: undefined, runtime: { ...runtime, id: 'other' } }] }
    task.runs.push(later)
    expect(reusableSession(task, member, runtime)).toBeUndefined()
    later.members[0].runtime = runtime
    task.events = [event('', { runId: 'later', kind: 'started' })]
    expect(reusableSession(task, member, runtime)).toBeUndefined()
  })

  it('retries the exact session after a failed resume instead of creating a new one', () => {
    const { task, member, runtime } = fixture()
    task.runs[0].members[0] = { ...task.runs[0].members[0], sessionId: 'retry-session', status: 'failed' }
    expect(reusableSession(task, member, runtime)).toBe('retry-session')
  })

  it('ignores session ids in tool output, foreign members and invalid protocol ids', () => {
    const { state, member, runtime, event } = fixture('claude')
    let next = applyRuntimeEvent(state, event(JSON.stringify({ type: 'assistant', session_id: 'forged', message: { content: [] } })))
    next = applyRuntimeEvent(next, event(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'child-session', parent_tool_use_id: 'tool' })))
    next = applyRuntimeEvent(next, event(JSON.stringify({ type: 'system', subtype: 'init', session_id: '--continue' })))
    next = applyRuntimeEvent(next, event(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'other-session' }), { memberId: 'other' }))
    expect(reusableSession(next.tasks[0], member, runtime)).toBeUndefined()
  })

  it('resumed turns keep the new instruction intact without duplicating saved history', () => {
    const { task, member } = fixture()
    task.messages = [{ id: 'old', role: 'assistant', text: 'already in native context', createdAt: task.createdAt }]
    const instruction = '新指令'.repeat(5000)
    const prompt = buildPrompt(task, instruction, member, true)
    expect(prompt).toContain(instruction)
    expect(prompt).not.toContain('already in native context')
    expect(prompt).toContain('继续当前 Runtime 原生会话')
  })
})
