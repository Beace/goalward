import { describe, expect, it } from 'vitest'
import { createInitialState, createTask } from './domain'
import { canAppendRunInput, getRuntimeCapabilities, queuedRunInput } from './runtime-capabilities'
import { getPendingRuntimeApprovals } from './runtime-approvals'
import type { RuntimeEvent } from './types'

function fixture() {
  const state = createInitialState()
  const task = createTask(state.settings, 'native capabilities', '/tmp', 'solo')
  const member = { ...task.members[0], runtime: state.settings.runtimes[0], model: '', status: 'running' as const }
  const run = { id: 'live', prompt: 'first', directory: task.directory, createdAt: task.createdAt, members: [member] }
  task.runs = [run]
  const frame = (payload: object, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ id: crypto.randomUUID(), taskId: task.id, runId: run.id, memberId: member.id, timestamp: task.createdAt, kind: 'stdout', text: JSON.stringify(payload) + '\n', ...overrides })
  return { task, run, member, frame }
}
describe('native connection capabilities and approvals', () => {
  it('keeps unknown, foreign and previous-run capabilities unavailable', () => {
    const f = fixture()
    expect(canAppendRunInput(f.task, f.member.id)).toBe(false)
    f.task.events.push(f.frame({ type: 'runtime.capabilities', steer: true }, { runId: 'old' }), f.frame({ type: 'runtime.capabilities', followUp: true }, { memberId: 'other' }))
    expect(canAppendRunInput(f.task, f.member.id)).toBe(false)
    f.task.events.push(f.frame({ type: 'runtime.capabilities', steer: true, followUp: false, approvals: true }))
    expect(getRuntimeCapabilities(f.task, f.run, f.member)).toEqual({ steer: true, followUp: false, approvals: true })
    expect(canAppendRunInput(f.task, f.member.id)).toBe(true)
    expect(queuedRunInput(f.task, f.member.id)).toBe(false)
  })
  it('distinguishes follow-up queue from steering and requires every broadcast recipient', () => {
    const f = fixture()
    f.task.events.push(f.frame({ type: 'runtime.capabilities', steer: false, followUp: true }))
    expect(queuedRunInput(f.task, f.member.id)).toBe(true)
    f.run.members.push({ ...f.member, id: 'second' })
    expect(canAppendRunInput(f.task, 'all')).toBe(false)
    expect(canAppendRunInput(f.task, f.member.id)).toBe(true)
    f.task.events.push(f.frame({ type: 'runtime.capabilities', steer: true }, { memberId: 'second' }))
    expect(canAppendRunInput(f.task, 'all')).toBe(true)
  })
  it.each(['codex', 'claude', 'kimi', 'pi'] as const)('routes only live %s requests and removes acknowledged choices', adapter => {
    const f = fixture(); f.member.runtime = { ...f.member.runtime, adapter }
    const request = { type: 'runtime.permission_requested', requestId: 'permission', toolCall: { title: 'Read workspace', rawInput: { file: '/tmp/readme' } }, options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }] }
    f.task.events.push(f.frame(request), f.frame(request, { runId: 'foreign' }))
    expect(getPendingRuntimeApprovals(f.task)).toHaveLength(1)
    expect(getPendingRuntimeApprovals(f.task)[0]).toMatchObject({ id: 'permission', runId: 'live', memberId: f.member.id, title: 'Read workspace' })
    f.task.events.push(f.frame({ type: 'runtime.permission_resolved', requestId: 'permission' }))
    expect(getPendingRuntimeApprovals(f.task)).toEqual([])
    f.task.events.push(f.frame({ ...request, requestId: 'later' }))
    f.run.members[0] = { ...f.member, status: 'completed' as never }
    expect(getPendingRuntimeApprovals(f.task)).toEqual([])
  })
})
