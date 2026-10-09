import { describe, expect, it } from 'vitest'
import { createInitialState, createTask } from './domain'
import { getTraceDisplayEntries } from './trace-calls'
import type { RuntimeEvent } from './types'

function fixture() {
  const settings = createInitialState().settings
  const task = createTask(settings, 'stream', '/tmp', 'solo')
  const member = { ...task.members[0], status: 'running' as const, model: '', runtime: { ...settings.runtimes[0], adapter: 'kimi' as const } }
  task.runs = [{ id: 'run', createdAt: task.createdAt, prompt: '', directory: '/tmp', members: [member, { ...member, id: 'other' }] }, { id: 'next', createdAt: task.createdAt, prompt: '', directory: '/tmp', members: [member] }]
  let sequence = 0
  const event = (payload: unknown, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ id: `event-${++sequence}`, taskId: task.id, runId: 'run', memberId: member.id, kind: 'stdout', timestamp: task.createdAt, text: JSON.stringify(payload) + '\n', ...overrides })
  const chunk = (text: string, overrides?: Partial<RuntimeEvent>) => event({ type: 'kimi.acp.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }, overrides)
  return { task, event, chunk }
}

describe('Kimi trace message aggregation', () => {
  it('retains exact text, all sources and a stable identity for thousands of chunks without modifying raw events', () => {
    const { task, chunk } = fixture()
    task.events = [chunk('第一段\n')]
    const id = getTraceDisplayEntries(task)[0].id
    task.events = [...task.events, ...Array.from({ length: 6000 }, (_, i) => chunk(`${i} 中文🙂 `))]
    const original = JSON.stringify(task.events)
    const entries = getTraceDisplayEntries(task)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe(id)
    expect(entries[0].message?.records).toHaveLength(6001)
    expect(entries[0].sourceIds).toEqual(task.events.map(event => event.id))
    expect(entries[0].message?.text).toBe('第一段\n' + Array.from({ length: 6000 }, (_, i) => `${i} 中文🙂 `).join(''))
    expect(entries[0].message?.status).toBe('running')
    expect(JSON.stringify(task.events)).toBe(original)
  })

  it('isolates runs and members while preserving continuity across interleaved members', () => {
    const { task, chunk } = fixture()
    task.events = [chunk('A'), chunk('other', { memberId: 'other' }), chunk('B'), chunk('next', { runId: 'next' }), chunk('C')]
    expect(getTraceDisplayEntries(task).map(entry => entry.message?.text)).toEqual(['ABC', 'other', 'next'])
    expect(getTraceDisplayEntries(task, task.runs[1]).map(entry => entry.message?.text)).toEqual(['next'])
  })

  it.each([
    { type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call', toolCallId: 'tool', kind: 'execute' } },
    { type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' } },
    { type: 'kimi.permission_requested', requestId: 'permission' },
    { type: 'kimi.acp.update', update: { sessionUpdate: 'plan', entries: [] } },
    { type: 'kimi.acp.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'image' } } },
    { type: 'kimi.acp.update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } } },
  ])('starts a separate reply after a different protocol event: %j', boundary => {
    const { task, chunk, event } = fixture()
    task.events = [chunk('before'), event(boundary), chunk('after')]
    const messages = getTraceDisplayEntries(task).filter(entry => entry.message)
    expect(messages.map(entry => entry.message?.text)).toEqual(['before', 'after'])
    expect(messages.map(entry => entry.message?.status)).toEqual(['received', 'running'])
  })

  it('does not merge across an already grouped tool update', () => {
    const { task, chunk, event } = fixture()
    task.events = [event({ type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call', toolCallId: 'tool' } }), chunk('before'), event({ type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' } }), chunk('after')]
    expect(getTraceDisplayEntries(task).filter(entry => entry.message).map(entry => entry.message?.text)).toEqual(['before', 'after'])
  })

  it('retains the row across incomplete transport frames and merges reassembled chunks', () => {
    const { task, chunk, event } = fixture()
    const second = chunk('后半段\n')
    task.events = [chunk('前半段'), event(null, { text: second.text.slice(0, 30) })]
    const first = getTraceDisplayEntries(task)[0]
    task.events.push(event(null, { text: second.text.slice(30) }))
    const merged = getTraceDisplayEntries(task)
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(first.id)
    expect(merged[0].message?.text).toBe('前半段后半段\n')
    expect(merged[0].sourceIds).toHaveLength(3)
  })

  it.each(['completed', 'failed', 'stopped'] as const)('settles streaming state after %s and does not join later text', kind => {
    const { task, chunk, event } = fixture()
    task.events = [chunk('before'), event(null, { kind, text: kind }), chunk('after')]
    expect(getTraceDisplayEntries(task).filter(entry => entry.message).map(entry => entry.message?.status)).toEqual([kind === 'failed' ? 'incomplete' : kind, 'running'])
  })

  it.each(['end_turn', 'cancelled', 'max_tokens'])('settles a prompt with stopReason %s', stopReason => {
    const { task, chunk, event } = fixture()
    task.events = [chunk('text'), event({ type: 'kimi.prompt_completed', stopReason })]
    expect(getTraceDisplayEntries(task)[0].message?.status).toBe(stopReason === 'end_turn' ? 'completed' : 'incomplete')
  })

  it('does not show restored interrupted streams as running', () => {
    const { task, chunk } = fixture()
    task.events = [chunk('text')]
    task.runs[0].members[0].status = 'interrupted'
    expect(getTraceDisplayEntries(task)[0].message?.status).toBe('incomplete')
  })
})
