import { describe, expect, it, vi } from 'vitest'
import { createInitialState, createTask, applyRuntimeEvent } from './domain'
import { getRunActivity, getRuntimeOutput } from './runtime-output'
import { getTraceDisplayEntries } from './trace-calls'
import { getPendingRuntimeApprovals, respondRuntimePermission } from './runtime-approvals'
import { validateRuntimePermissions } from './runtime-permissions'
import { getReasoningOptions } from './reasoning'
import type { RuntimeEvent } from './types'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))

function fixture() {
  const state = createInitialState()
  const task = createTask(state.settings, 'Kimi test', '/tmp/kimi', 'solo')
  task.runs = [{ id: 'run-kimi', createdAt: new Date(0).toISOString(), directory: task.directory, prompt: 'test', members: [{ ...task.members[0], runtime: { ...state.settings.runtimes[0], id: 'kimi', adapter: 'kimi', name: 'Kimi CLI' }, model: '', status: 'running' }] }]
  state.tasks = [task]
  let sequence = 0
  const event = (text: string, kind: RuntimeEvent['kind'] = 'stdout'): RuntimeEvent => ({ id: `event-${++sequence}`, taskId: task.id, runId: task.runs[0].id, memberId: task.members[0].id, timestamp: new Date(sequence * 1000).toISOString(), kind, text })
  const json = (payload: unknown) => event(JSON.stringify(payload) + '\n')
  const update = (payload: unknown) => json({ type: 'kimi.acp.update', update: payload })
  return { state, event, json, update }
}
const permission = { type: 'kimi.permission_requested', requestId: 'request-1', toolCall: { title: 'Write file', rawInput: { path: '/tmp/example' } }, options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }] }

describe('Kimi ACP public projection and permissions', () => {
  it('streams fragmented public text, separates tool turns and never promotes thought or tool output to chat', () => {
    const f = fixture()
    let state = f.state
    const frames = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Bash', kind: 'execute', rawInput: { command: 'echo safe' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'TOOL_ONLY' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结论' } },
    ].map(update => JSON.stringify({ type: 'kimi.acp.update', update })).join('\n') + '\n'
    for (let index = 0; index < frames.length; index += 19) state = applyRuntimeEvent(state, f.event(frames.slice(index, index + 19)))
    const task = state.tasks[0], run = task.runs[0]
    expect(getRuntimeOutput(task, run, run.members[0]).map(output => output.text)).toEqual(['第一段继续', '结论'])
    expect(getRunActivity(task, run).phase).toBe('responding')
    const calls = getTraceDisplayEntries(task).filter(entry => entry.call)
    expect(calls).toHaveLength(1)
    expect(calls[0].call).toMatchObject({ id: 'tool', status: 'completed', input: { command: 'echo safe' }, output: 'TOOL_ONLY' })
    expect(JSON.stringify(task.messages)).not.toContain('PRIVATE')
    state = applyRuntimeEvent(state, f.event('Kimi ACP prompt completed', 'completed'))
    expect(state.tasks[0].messages.every(message => !message.streaming)).toBe(true)
  })

  it('only offers active scoped approvals and removes answered and interrupted requests', async () => {
    const f = fixture()
    const frame = JSON.stringify(permission) + '\n'
    let state = applyRuntimeEvent(f.state, f.event(frame.slice(0, 31)))
    expect(getPendingRuntimeApprovals(state.tasks[0])).toHaveLength(0)
    state = applyRuntimeEvent(state, f.event(frame.slice(31)))
    const requests = getPendingRuntimeApprovals(state.tasks[0])
    expect(requests).toHaveLength(1)
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).label).toBe('等待工具权限确认')
    await respondRuntimePermission(requests[0], 'deny')
    expect(invoke).toHaveBeenCalledWith('respond_runtime_permission', { runId: 'run-kimi', memberId: state.tasks[0].members[0].id, requestId: 'request-1', optionId: 'deny' })
    state = applyRuntimeEvent(state, f.json({ type: 'kimi.permission_resolved', requestId: 'request-1', optionId: 'deny' }))
    expect(getPendingRuntimeApprovals(state.tasks[0])).toHaveLength(0)
    state = applyRuntimeEvent(state, f.json({ ...permission, requestId: 'request-2' }))
    state = applyRuntimeEvent(state, f.event('stopped', 'stopped'))
    expect(getPendingRuntimeApprovals(state.tasks[0])).toHaveLength(0)
  })

  it('leaves unknown model thinking inherited and rejects incompatible print / auto flags', () => {
    const runtime = fixture().state.tasks[0].runs[0].members[0].runtime
    expect(getReasoningOptions(runtime).map(option => option.value)).toEqual(['inherit'])
    expect(validateRuntimePermissions({ ...runtime, args: [] })).toBeUndefined()
    expect(validateRuntimePermissions({ ...runtime, args: ['--auto'] })).toContain('不接受额外启动参数')
  })
})
