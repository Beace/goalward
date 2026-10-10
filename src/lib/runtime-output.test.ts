import { describe, expect, it, vi } from 'vitest'
import * as i18n from '@/i18n'
import { applyRuntimeEvent, createInitialState, createTask, getRunActivity, recoverInterruptedState } from './domain'
import type { Adapter, AppState, RuntimeEvent } from './types'

function fixture(adapter: Adapter = 'claude') {
  const initial = createInitialState()
  const task = createTask(initial.settings, '流式验证', '/tmp/project', 'solo')
  const member = task.members[0]
  task.runs = [{ id: 'run', createdAt: '2026-09-16T03:00:00Z', prompt: 'test', directory: task.directory, members: [{ ...member, runtime: { ...initial.settings.runtimes[0], adapter }, model: '', status: 'running' }] }]
  let sequence = 0
  const event = (kind: RuntimeEvent['kind'], text = '', overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    id: `event-${++sequence}`, taskId: task.id, runId: 'run', memberId: member.id,
    timestamp: new Date(Date.parse(task.runs[0].createdAt) + sequence * 1000).toISOString(), kind, text, ...overrides,
  })
  const json = (payload: unknown, overrides?: Partial<RuntimeEvent>) => event('stdout', JSON.stringify(payload) + '\n', overrides)
  const stream = (payload: unknown, overrides?: Partial<RuntimeEvent>) => json({ type: 'stream_event', event: payload }, overrides)
  return { state: { ...initial, tasks: [task] } as AppState, event, json, stream, member }
}
const start = (id: string) => ({ type: 'message_start', message: { id, role: 'assistant', content: [] } })
const textBlock = (index = 0) => ({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const delta = (text: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })

describe('public streaming output', () => {
  it('shows Claude text before the final message, then replaces the same message without duplicate result text', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message-1')))
    state = applyRuntimeEvent(state, f.stream(textBlock()))
    state = applyRuntimeEvent(state, f.stream(delta('你好')))
    const first = state.tasks[0].messages[0]
    expect(first).toMatchObject({ text: '你好', streaming: true })
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('responding')
    state = applyRuntimeEvent(state, f.stream(delta('，世界')))
    expect(state.tasks[0].messages[0]).toMatchObject({ id: first.id, text: '你好，世界', createdAt: first.createdAt, streaming: true })
    state = applyRuntimeEvent(state, f.stream({ type: 'message_stop' }))
    state = applyRuntimeEvent(state, f.json({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: '你好，世界。' }] } }))
    state = applyRuntimeEvent(state, f.json({ type: 'result', result: '你好，世界。' }))
    expect(state.tasks[0].messages).toHaveLength(1)
    expect(state.tasks[0].messages[0]).toMatchObject({ id: first.id, text: '你好，世界。', streaming: false })
    expect(first.text).toBe('你好')
  })

  it('reassembles fragmented thinking and text blocks while keeping signatures and tool JSON out of visible messages', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message-2')))
    const frames = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE_START' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING', text: 'PRIVATE_TEXT' } },
      textBlock(1), delta('公开第一段', 1),
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Read', input: { text: 'PRIVATE_TOOL' } } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'PRIVATE_INPUT' } },
      textBlock(3), delta('公开第二段', 3),
    ].map(event => JSON.stringify({ type: 'stream_event', event })).join('\n') + '\n'
    for (let offset = 0; offset < frames.length; offset += 17) state = applyRuntimeEvent(state, f.event('stdout', frames.slice(offset, offset + 17)))
    expect(state.tasks[0].messages.map(message => [message.kind, message.text])).toEqual([
      ['reasoning', 'PRIVATE_STARTPRIVATE_THINKING'],
      ['message', '公开第一段\n\n公开第二段'],
    ])
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE_TEXT')
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE_SIGNATURE')
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE_TOOL')
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE_INPUT')
    expect(state.tasks[0].events.some(event => event.text.includes('PRIVATE'))).toBe(true)
  })

  it('preserves earlier state, isolates members and tasks, and reconstructs identical text after cache loss', () => {
    const f = fixture()
    const other = { ...f.state.tasks[0].runs[0].members[0], id: 'other' }
    f.state.tasks[0].runs[0].members.push(other)
    let state = applyRuntimeEvent(f.state, f.stream(start('same-message')))
    state = applyRuntimeEvent(state, f.stream(textBlock()))
    state = applyRuntimeEvent(state, f.stream(delta('A')))
    const earlier = state
    state = applyRuntimeEvent(state, f.stream(start('same-message'), { memberId: 'other' }))
    state = applyRuntimeEvent(state, f.stream(textBlock(), { memberId: 'other' }))
    state = applyRuntimeEvent(state, f.stream(delta('B'), { memberId: 'other' }))
    const nextEvent = f.stream(delta('2'))
    const restored = JSON.parse(JSON.stringify(state)) as AppState
    const incremental = applyRuntimeEvent(state, nextEvent)
    const replayed = applyRuntimeEvent(restored, nextEvent)
    expect(replayed).toEqual(incremental)
    expect(earlier.tasks[0].messages.map(message => message.text)).toEqual(['A'])
    expect(incremental.tasks[0].messages.map(message => [message.memberId, message.text])).toEqual([[f.member.id, 'A2'], ['other', 'B']])

    const independent = fixture()
    let separate = applyRuntimeEvent(independent.state, independent.stream(start('same-message')))
    separate = applyRuntimeEvent(separate, independent.stream(textBlock()))
    separate = applyRuntimeEvent(separate, independent.stream(delta('独立任务')))
    expect(separate.tasks[0].messages.map(message => message.text)).toEqual(['独立任务'])
    expect(getRunActivity(earlier.tasks[0], earlier.tasks[0].runs[0]).lastEventAt).not.toBe(nextEvent.timestamp)
  })

  it.each(['completed', 'failed', 'stopped'] as const)('closes partial messages on process %s and never restarts them with late stdout', kind => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message')))
    state = applyRuntimeEvent(state, f.stream(textBlock()))
    state = applyRuntimeEvent(state, f.stream(delta('部分答复')))
    state = applyRuntimeEvent(state, f.event(kind))
    expect(state.tasks[0].messages[0].streaming).toBe(false)
    state = applyRuntimeEvent(state, f.stream(delta('尾部')))
    expect(state.tasks[0].messages[0]).toMatchObject({ text: '部分答复尾部', streaming: false })
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe(kind)
  })

  it('clears streaming indicators when restoring an interrupted application', () => {
    const f = fixture('generic')
    const state = applyRuntimeEvent(f.state, f.event('stdout', '部分输出'))
    expect(state.tasks[0].messages[0].streaming).toBe(true)
    const restored = recoverInterruptedState(state)
    expect(restored.tasks[0].messages[0].streaming).toBe(false)
    expect(getRunActivity(restored.tasks[0], restored.tasks[0].runs[0]).phase).toBe('interrupted')
  })

  it('reconstructs public text ignored by an older UI from persisted events without needing another stdout event', () => {
    const f = fixture()
    f.state.tasks[0].events = [f.stream(start('old-message')), f.stream(textBlock()), f.stream(delta('重载后可见'))]
    expect(f.state.tasks[0].messages).toEqual([])
    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    expect(recovered.tasks[0].messages).toHaveLength(1)
    expect(recovered.tasks[0].messages[0]).toMatchObject({ text: '重载后可见', streaming: false })
    expect(recoverInterruptedState(recovered)).toEqual(recovered)
  })

  it('reconstructs a persisted Claude thinking stream as one stable reasoning message', () => {
    const f = fixture()
    f.state.tasks[0].events = [
      f.stream(start('thinking-message')),
      f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先检查' } }),
      f.json({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 4, estimated_tokens_delta: 4 }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '上下文。' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
    ]
    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    expect(recovered.tasks[0].messages).toHaveLength(1)
    expect(recovered.tasks[0].messages[0]).toMatchObject({ kind: 'reasoning', text: '先检查上下文。', streaming: false })
  })

  it.each([['公开答复'], ['公开第一段', '公开第二段']])('migrates an older saved Claude result without duplicating replayed deltas: %j', (...parts) => {
    const f = fixture()
    const task = f.state.tasks[0]
    task.runs[0].members[0].status = 'completed'
    task.events = parts.flatMap((text, index) => [f.stream(start(`old-${index}`)), f.stream(textBlock()), f.stream(delta(text)), f.stream({ type: 'message_stop' })])
    task.events.push(f.json({ type: 'result', uuid: 'old-result', result: parts.join('\n\n') }))
    task.messages = [{ id: `runtime:run:${f.member.id}:result:old-result`, role: 'assistant', runId: 'run', memberId: f.member.id, text: parts.join('\n\n'), createdAt: task.events.at(-1)!.timestamp }]

    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    expect(recovered.tasks[0].messages.map(message => message.text)).toEqual(parts)
    expect(recovered.tasks[0].messages.every(message => message.streaming === false)).toBe(true)
    expect(recoverInterruptedState(JSON.parse(JSON.stringify(recovered)) as AppState)).toEqual(recovered)
    expect(task.messages).toHaveLength(1)
    expect(task.messages[0].id).toContain(':result:old-result')
  })

  it('retains saved results whose trace is missing, incomplete, or belongs to another member', () => {
    const f = fixture()
    const task = f.state.tasks[0]
    const other = { ...task.runs[0].members[0], id: 'other' }
    task.runs[0].members.push(other)
    task.events = [f.stream(start('partial')), f.stream(textBlock()), f.stream(delta('公开部分'))]
    task.messages = [
      { id: `runtime:run:${f.member.id}:result:complete`, role: 'assistant', runId: 'run', memberId: f.member.id, text: '公开部分及缺失的后续', createdAt: task.createdAt },
      { id: 'runtime:run:other:result:other', role: 'assistant', runId: 'run', memberId: 'other', text: '公开部分', createdAt: task.createdAt },
    ]
    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    for (const message of task.messages) expect(recovered.tasks[0].messages).toContainEqual(message)
    expect(recovered.tasks[0].messages).toHaveLength(3)

    task.events = []
    expect(recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState).tasks[0].messages).toEqual(task.messages)
  })

  it('preserves leading whitespace emitted in a separate generic output chunk', () => {
    const f = fixture('generic')
    let state = applyRuntimeEvent(f.state, f.event('stdout', '    '))
    state = applyRuntimeEvent(state, f.event('stdout', 'indented code'))
    expect(state.tasks[0].messages[0].text).toBe('    indented code')
  })

  it('parses only new frames during a long delta stream instead of replaying all previous JSON', () => {
    const f = fixture()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      let state = applyRuntimeEvent(f.state, f.stream(start('many-deltas')))
      state = applyRuntimeEvent(state, f.stream(textBlock()))
      for (let index = 0; index < 100; index++) state = applyRuntimeEvent(state, f.stream(delta('字')))
      expect(state.tasks[0].messages[0].text).toBe('字'.repeat(100))
      expect(parse.mock.calls.length).toBeLessThanOrEqual(104)
    } finally { parse.mockRestore() }
  })
})

describe('run activity from actual protocol events', () => {
  it('reflects a real Codex web search lifecycle and keeps protocol turn completion distinct from process exit', () => {
    const f = fixture('codex')
    let state = applyRuntimeEvent(f.state, f.event('started'))
    state = applyRuntimeEvent(state, f.json({ type: 'turn.started' }))
    state = applyRuntimeEvent(state, f.json({ type: 'item.started', item: { id: 'search-1', type: 'web_search', query: '' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'web-search', label: '正在检索网页' })
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'search-1', type: 'web_search', query: 'AI news' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'waiting', summary: 'AI news' })
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '检索结果' } }))
    expect(state.tasks[0].messages[0]).toMatchObject({ text: '检索结果', streaming: false })
    state = applyRuntimeEvent(state, f.json({ type: 'turn.completed', usage: {} }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('waiting')
    const terminal = f.event('completed')
    state = applyRuntimeEvent(state, terminal)
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'completed', lastEventAt: terminal.timestamp })
  })

  it('handles public Codex item snapshots while keeping reasoning and raw command arguments out of summaries', () => {
    const f = fixture('codex')
    let state = applyRuntimeEvent(f.state, f.json({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: '公开' } }))
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '公开结果' } }))
    expect(state.tasks[0].messages).toHaveLength(1)
    state = applyRuntimeEvent(state, f.json({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'SECRET_COMMAND' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'tool', summary: '执行本机命令' })
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('waiting')
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } }))
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE')
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBeUndefined()
  })

  it('localizes generated Codex tool summaries without translating runtime-provided tool names', () => {
    const f = fixture('codex')
    const language = vi.spyOn(i18n, 'getCurrentLanguage').mockReturnValue('en')
    try {
      let state = applyRuntimeEvent(f.state, f.json({ type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'private command' } }))
      expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBe('Run local command')
      language.mockReturnValue('zh')
      expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBe('执行本机命令')
      language.mockReturnValue('en')

      state = applyRuntimeEvent(state, f.json({ type: 'item.started', item: { id: 'file', type: 'file_change' } }))
      expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBe('Update workspace files')

      state = applyRuntimeEvent(state, f.json({ type: 'item.started', item: { id: 'unnamed', type: 'mcp_tool_call' } }))
      expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBe('Call tool')

      state = applyRuntimeEvent(state, f.json({ type: 'item.started', item: { id: 'named', type: 'mcp_tool_call', tool: '执行本机命令' } }))
      expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).summary).toBe('执行本机命令')
    } finally { language.mockRestore() }
  })

  it('shows Claude tools until their result arrives, then reports waiting', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.json({ type: 'assistant', message: { id: 'tool-call', content: [{ type: 'tool_use', name: 'WebSearch', input: { secret: 'PRIVATE' } }] } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('web-search')
    state = applyRuntimeEvent(state, f.json({ type: 'user', message: { content: [{ type: 'tool_result', content: 'PRIVATE_TOOL_OUTPUT' }] } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('waiting')
    expect(state.tasks[0].messages).toEqual([])
  })
})
