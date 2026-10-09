import { describe, expect, it } from 'vitest'
import { applyRuntimeEvent, createInitialState, createTask } from './domain'
import { getRuntimeOutput, getRuntimeSessionId } from './runtime-output'
import { getTraceDisplayEntries } from './trace-calls'
import { reusableSession } from './runtime-session'
import { mergeLocalDiscovery } from './onboarding'
import { validatePiArguments } from './pi-runtime'
import { getReasoningOptions } from './reasoning'
import type { RuntimeEvent } from './types'

function fixture() {
  const state = createInitialState()
  const runtime = { ...state.settings.runtimes.find(item => item.id === 'pi')!, enabled: true }
  state.settings.runtimes = [runtime]
  state.settings.defaultRuntime = 'pi'
  const task = createTask(state.settings, 'Pi', '/tmp/pi-test', 'solo')
  task.runs = [{ id: 'run-pi', createdAt: task.createdAt, directory: task.directory, prompt: 'hello', members: [{ ...task.members[0], runtime, model: '', status: 'running' }] }]
  state.tasks = [task]
  let sequence = 0
  const event = (text: string, kind: RuntimeEvent['kind'] = 'stdout'): RuntimeEvent => ({ id: `e-${++sequence}`, taskId: task.id, runId: 'run-pi', memberId: task.members[0].id, timestamp: new Date(sequence * 1000).toISOString(), kind, text })
  return { state, task, runtime, event }
}
const delta = (type: string, contentIndex: number, delta: string) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex, delta } })

describe('Pi runtime', () => {
  it('replays fragmented JSON, reconciles final content, groups tools and preserves session continuity', () => {
    const f = fixture()
    let state = f.state
    const frames = [
      { type: 'session', id: 'pi-session-1' },
      { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'USER_ONLY' }] } },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      delta('thinking_delta', 0, '检查上下文'), delta('text_delta', 1, '第一'), delta('text_delta', 1, '段🙂'),
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '检查上下文' }, { type: 'text', text: '第一段🙂' }, { type: 'toolCall', id: 'tool-1', name: 'bash' }] } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo test' } },
      { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'PARTIAL' }] } },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'TOOL_ONLY' }] }, isError: false },
      { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'TOOL_ONLY' }] } },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      delta('text_delta', 0, '结'),
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '结论' }] } },
      { type: 'agent_end', messages: [] },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n'
    for (let i = 0; i < frames.length; i += 23) state = applyRuntimeEvent(state, f.event(frames.slice(i, i + 23)))
    state = applyRuntimeEvent(state, f.event('done', 'completed'))
    const task = state.tasks[0], run = task.runs[0], member = run.members[0]
    const output = getRuntimeOutput(task, run, member)
    expect(output.map(item => [item.kind, item.text])).toEqual([['reasoning', '检查上下文'], ['message', '第一段🙂'], ['message', '结论']])
    expect(output.every(item => !item.streaming)).toBe(true)
    const reloaded = structuredClone(task)
    expect(getRuntimeOutput(reloaded, reloaded.runs[0], reloaded.runs[0].members[0])).toEqual(output)
    expect(getRuntimeSessionId(task, run, member)).toBe('pi-session-1')
    expect(reusableSession(reloaded, reloaded.members[0], f.runtime)).toBe('pi-session-1')
    const trace = getTraceDisplayEntries(task)
    const calls = trace.filter(item => item.call)
    expect(calls).toHaveLength(1)
    expect(calls[0].call).toMatchObject({ id: 'tool-1', status: 'completed', input: { command: 'echo test' }, output: { content: [{ type: 'text', text: 'TOOL_ONLY' }] } })
    expect(trace.filter(item => item.message).map(item => item.message?.text)).toEqual(['第一段🙂', '结论'])
    expect(trace.filter(item => item.reasoning).map(item => item.reasoning?.text)).toEqual(['检查上下文'])
    expect(JSON.stringify(task.messages)).not.toMatch(/TOOL_ONLY|USER_ONLY|PARTIAL/)
  })

  it('keeps one trace row and stable chat identity while streaming', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.event(JSON.stringify({ type: 'message_start', message: { role: 'assistant' } }) + '\n'))
    state = applyRuntimeEvent(state, f.event(JSON.stringify(delta('text_delta', 0, 'A')) + '\n'))
    const first = getRuntimeOutput(state.tasks[0], state.tasks[0].runs[0], state.tasks[0].runs[0].members[0])[0]
    for (let i = 0; i < 100; i++) state = applyRuntimeEvent(state, f.event(JSON.stringify(delta('text_delta', 0, 'B')) + '\n'))
    const output = getRuntimeOutput(state.tasks[0], state.tasks[0].runs[0], state.tasks[0].runs[0].members[0])
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ key: first.key, text: 'A' + 'B'.repeat(100), streaming: true })
    expect(getTraceDisplayEntries(state.tasks[0]).filter(item => item.message)).toHaveLength(1)
    state = applyRuntimeEvent(state, f.event('stopped', 'stopped'))
    expect(getTraceDisplayEntries(state.tasks[0]).find(item => item.message)?.message?.status).toBe('stopped')
  })

  it('gives full-message blocks unique trace identities and rejects conflicting CLI options', () => {
    const f = fixture()
    const state = applyRuntimeEvent(f.state, f.event(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'answer' }] } }) + '\n'))
    const trace = getTraceDisplayEntries(state.tasks[0])
    expect(new Set(trace.map(item => item.id)).size).toBe(trace.length)
    expect(validatePiArguments(['--tools', 'read,ls', '--no-extensions'])).toBeUndefined()
    expect(validatePiArguments(['--continue'])).toContain('不支持')
    expect(validatePiArguments(['--mode=rpc'])).toContain('不支持')
    expect(validatePiArguments(['--tools'])).toContain('缺少')
  })

  it('imports Pi into older settings without overwriting existing runtimes and does not invent thinking levels', () => {
    const state = createInitialState()
    state.settings.runtimes = state.settings.runtimes.filter(item => item.id !== 'pi')
    const before = structuredClone(state.settings.runtimes)
    const next = mergeLocalDiscovery(state.settings, { scannedAt: '', runtimes: [{ id: 'pi', name: 'Pi', executable: 'pi', adapter: 'pi', probe: { found: true, path: '/opt/pi', version: '0.85.1' }, models: [{ modelId: 'deepseek/deepseek-v4-pro', name: 'Pro', source: 'settings.json', selected: true }], configSources: [], warnings: [] }] }, ['pi'], 'pi')
    expect(next.runtimes.filter(item => item.id !== 'pi')).toEqual(before)
    expect(next.runtimes.find(item => item.id === 'pi')).toMatchObject({ enabled: true, adapter: 'pi', defaultModel: 'deepseek/deepseek-v4-pro' })
    expect(getReasoningOptions(next.runtimes.at(-1), next.models[0]).map(item => item.value)).toEqual(['inherit'])
  })
})
