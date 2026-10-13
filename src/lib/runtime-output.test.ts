import { describe, expect, it, vi } from 'vitest'
import * as i18n from '@/i18n'
import { applyRuntimeEvent, createInitialState, createTask, getRunActivity, recoverInterruptedState } from './domain'
import type { Adapter, AppState, RuntimeEvent } from './types'

function fixture(adapter: Adapter = 'claude') {
  const initial = createInitialState()
  const task = createTask(initial.settings, 'Streaming verification', '/tmp/project', 'solo')
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

describe('Codex app-server activity', () => {
  it('shows turn, public reasoning and typed tool progress without exposing raw reasoning or treating usage as a new phase', () => {
    const f = fixture('codex')
    const raw = (method: string, data: object = {}) => f.json({ method, params: { threadId: 'thread', turnId: 'turn', ...data } })
    const item = (type: string, data: object) => f.json({ type: 'codex.app_server.item', threadId: 'thread', turnId: 'turn', eventType: type, item: data })
    let state = applyRuntimeEvent(f.state, f.json({ type: 'thread.started', thread_id: 'thread' }))
    state = applyRuntimeEvent(state, raw('turn/started', { turn: { id: 'turn', status: 'inProgress' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'waiting', label: '等待 Runtime 输出' })
    state = applyRuntimeEvent(state, raw('item/reasoning/summaryPartAdded', { itemId: 'thinking', summaryIndex: 0 }))
    state = applyRuntimeEvent(state, raw('item/reasoning/summaryTextDelta', { itemId: 'thinking', summaryIndex: 0, delta: 'Check ' }))
    state = applyRuntimeEvent(state, raw('item/reasoning/summaryTextDelta', { itemId: 'thinking', summaryIndex: 0, delta: 'constraints.' }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'waiting', label: '正在思考', summary: 'Check constraints.' })
    state = applyRuntimeEvent(state, raw('item/reasoning/textDelta', { itemId: 'thinking', delta: 'PRIVATE_RAW_THINKING' }))
    state = applyRuntimeEvent(state, item('item.completed', { id: 'thinking', type: 'reasoning', summary: ['Check constraints.'], content: ['PRIVATE_CONTENT'], signature: 'PRIVATE_SIGNATURE' }))
    expect(state.tasks[0].messages).toHaveLength(1)
    expect(state.tasks[0].messages[0]).toMatchObject({ kind: 'reasoning', text: 'Check constraints.', streaming: false })
    expect(JSON.stringify(state.tasks[0].messages)).not.toContain('PRIVATE')
    state = applyRuntimeEvent(state, item('item.started', { id: 'search', type: 'webSearch', query: 'API material' }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'web-search', summary: 'API material' })
    state = applyRuntimeEvent(state, item('item.started', { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'read', arguments: { topic: 'streaming' }, status: 'inProgress' }))
    state = applyRuntimeEvent(state, raw('item/mcpToolCall/progress', { itemId: 'mcp', message: 'Reading documents' }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'tool', summary: 'Reading documents' })
    state = applyRuntimeEvent(state, raw('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 24, outputTokens: 8 }, total: { inputTokens: 200, outputTokens: 100 } } }))
    state = applyRuntimeEvent(state, raw('model/rerouted', { fromModel: 'configured', toModel: 'actual', reason: 'capacity' }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'tool', summary: 'Reading documents' })
    state = applyRuntimeEvent(state, item('item.completed', { id: 'mcp', type: 'mcpToolCall', status: 'completed', result: { text: 'Material received' } }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'waiting', label: '工具已返回，等待 Runtime 下一步' })
    state = applyRuntimeEvent(state, raw('item/agentMessage/delta', { itemId: 'answer', delta: 'Continue organizing tasks.' }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('responding')
    state = applyRuntimeEvent(state, f.event('stopped'))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('stopped')
    expect(state.tasks[0].messages.every(message => !message.streaming)).toBe(true)
  })

  it('ignores foreign thread or turn public activity during trace recovery', () => {
    const f = fixture('codex')
    let state = applyRuntimeEvent(f.state, f.json({ type: 'thread.started', thread_id: 'thread' }))
    state = applyRuntimeEvent(state, f.json({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } }))
    for (const [threadId, turnId] of [['foreign', 'turn'], ['thread', 'other-turn']]) {
      state = applyRuntimeEvent(state, f.json({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: 'FOREIGN_REPLY' } }))
      state = applyRuntimeEvent(state, f.json({ type: 'codex.app_server.item', threadId, turnId, eventType: 'item.started', item: { id: 'tool', type: 'commandExecution', command: 'FOREIGN_COMMAND' } }))
    }
    expect(state.tasks[0].messages).toHaveLength(0)
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('waiting')
  })
})

describe('public streaming output', () => {
  it('restores streaming for a confirmed live interrupted route without reviving a terminal Run', () => {
    const f = fixture('codex')
    const change = f.json({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'Still streaming' } })
    const state = applyRuntimeEvent(f.state, change)
    state.tasks[0].runs[0].members[0].status = 'interrupted'
    const active = [{ runId: 'run', memberId: f.member.id }]
    const recovered = recoverInterruptedState(state, active)
    expect(recovered.tasks[0].runs[0].members[0].status).toBe('running')
    expect(recovered.tasks[0].messages[0]).toMatchObject({ text: 'Still streaming', streaming: true })
    state.tasks[0].runs[0].members[0].status = 'completed'
    const terminal = recoverInterruptedState(state, active)
    expect(terminal.tasks[0].runs[0].members[0].status).toBe('completed')
    expect(terminal.tasks[0].messages[0].streaming).toBe(false)
  })
  it('appends Codex app-server deltas across transport fragments and reconciles the final item without duplicates', () => {
    const f = fixture('codex')
    const item = (type: string, text: string) => f.json({ type, item: { id: 'answer', type: 'agent_message', text } })
    const change = (delta: string) => f.json({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta } })
    let state = applyRuntimeEvent(f.state, item('item.started', ''))
    state = applyRuntimeEvent(state, change('Define '))
    const first = state.tasks[0].messages[0]
    expect(first).toMatchObject({ text: 'Define ', streaming: true })
    const frame = change('success criteria.')
    for (let offset = 0; offset < frame.text.length; offset += 7) {
      state = applyRuntimeEvent(state, f.event('stdout', frame.text.slice(offset, offset + 7)))
    }
    expect(state.tasks[0].messages).toHaveLength(1)
    expect(state.tasks[0].messages[0]).toMatchObject({ id: first.id, text: 'Define success criteria.', streaming: true })
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('responding')
    // Replaying a cache-less persisted trace must append each frame only once.
    const restored = JSON.parse(JSON.stringify(state)) as AppState
    const final = item('item.completed', 'Define success criteria first. Then verify the current state.')
    const replayed = applyRuntimeEvent(restored, final)
    expect(replayed).toEqual(applyRuntimeEvent(state, final))
    expect(replayed.tasks[0].messages).toHaveLength(1)
    expect(replayed.tasks[0].messages[0]).toMatchObject({ id: first.id, text: 'Define success criteria first. Then verify the current state.', streaming: false })
    expect(first.text).toBe('Define ')
  })

  it.each(['failed', 'stopped'] as const)('retains a Codex delta-only partial reply after %s and journal recovery', kind => {
    const f = fixture('codex')
    const delta = f.json({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'Incomplete reply' } })
    let state = applyRuntimeEvent(f.state, delta)
    state = applyRuntimeEvent(state, f.event(kind))
    expect(state.tasks[0].messages[0]).toMatchObject({ text: 'Incomplete reply', streaming: false })
    const restored = JSON.parse(JSON.stringify(state)) as AppState
    restored.tasks[0].messages = []
    expect(recoverInterruptedState(restored).tasks[0].messages[0]).toMatchObject({ text: 'Incomplete reply', streaming: false })
  })

  it('shows Claude text before the final message, then replaces the same message without duplicate result text', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message-1')))
    state = applyRuntimeEvent(state, f.stream(textBlock()))
    state = applyRuntimeEvent(state, f.stream(delta('Hello')))
    const first = state.tasks[0].messages[0]
    expect(first).toMatchObject({ text: 'Hello', streaming: true })
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('responding')
    state = applyRuntimeEvent(state, f.stream(delta(', world')))
    expect(state.tasks[0].messages[0]).toMatchObject({ id: first.id, text: 'Hello, world', createdAt: first.createdAt, streaming: true })
    state = applyRuntimeEvent(state, f.stream({ type: 'message_stop' }))
    state = applyRuntimeEvent(state, f.json({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: 'Hello, world.' }] } }))
    state = applyRuntimeEvent(state, f.json({ type: 'result', result: 'Hello, world.' }))
    expect(state.tasks[0].messages).toHaveLength(1)
    expect(state.tasks[0].messages[0]).toMatchObject({ id: first.id, text: 'Hello, world.', streaming: false })
    expect(first.text).toBe('Hello')
  })

  it('reassembles fragmented thinking and text blocks while keeping signatures and tool JSON out of visible messages', () => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message-2')))
    const frames = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE_START' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING', text: 'PRIVATE_TEXT' } },
      textBlock(1), delta('First public segment', 1),
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Read', input: { text: 'PRIVATE_TOOL' } } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'PRIVATE_INPUT' } },
      textBlock(3), delta('Second public segment', 3),
    ].map(event => JSON.stringify({ type: 'stream_event', event })).join('\n') + '\n'
    for (let offset = 0; offset < frames.length; offset += 17) state = applyRuntimeEvent(state, f.event('stdout', frames.slice(offset, offset + 17)))
    expect(state.tasks[0].messages.map(message => [message.kind, message.text])).toEqual([
      ['reasoning', 'PRIVATE_STARTPRIVATE_THINKING'],
      ['message', 'First public segment\n\nSecond public segment'],
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
    separate = applyRuntimeEvent(separate, independent.stream(delta('Independent task')))
    expect(separate.tasks[0].messages.map(message => message.text)).toEqual(['Independent task'])
    expect(getRunActivity(earlier.tasks[0], earlier.tasks[0].runs[0]).lastEventAt).not.toBe(nextEvent.timestamp)
  })

  it.each(['completed', 'failed', 'stopped'] as const)('closes partial messages on process %s and never restarts them with late stdout', kind => {
    const f = fixture()
    let state = applyRuntimeEvent(f.state, f.stream(start('message')))
    state = applyRuntimeEvent(state, f.stream(textBlock()))
    state = applyRuntimeEvent(state, f.stream(delta('Partial reply')))
    state = applyRuntimeEvent(state, f.event(kind))
    expect(state.tasks[0].messages[0].streaming).toBe(false)
    state = applyRuntimeEvent(state, f.stream(delta(' tail')))
    expect(state.tasks[0].messages[0]).toMatchObject({ text: 'Partial reply tail', streaming: false })
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe(kind)
  })

  it('clears streaming indicators when restoring an interrupted application', () => {
    const f = fixture('generic')
    const state = applyRuntimeEvent(f.state, f.event('stdout', 'Partial output'))
    expect(state.tasks[0].messages[0].streaming).toBe(true)
    const restored = recoverInterruptedState(state)
    expect(restored.tasks[0].messages[0].streaming).toBe(false)
    expect(getRunActivity(restored.tasks[0], restored.tasks[0].runs[0]).phase).toBe('interrupted')
  })

  it('reconstructs public text ignored by an older UI from persisted events without needing another stdout event', () => {
    const f = fixture()
    f.state.tasks[0].events = [f.stream(start('old-message')), f.stream(textBlock()), f.stream(delta('Visible after reload'))]
    expect(f.state.tasks[0].messages).toEqual([])
    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    expect(recovered.tasks[0].messages).toHaveLength(1)
    expect(recovered.tasks[0].messages[0]).toMatchObject({ text: 'Visible after reload', streaming: false })
    expect(recoverInterruptedState(recovered)).toEqual(recovered)
  })

  it('reconstructs a persisted Claude thinking stream as one stable reasoning message', () => {
    const f = fixture()
    f.state.tasks[0].events = [
      f.stream(start('thinking-message')),
      f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } }),
      f.json({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 4, estimated_tokens_delta: 4 }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the context.' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
    ]
    const recovered = recoverInterruptedState(JSON.parse(JSON.stringify(f.state)) as AppState)
    expect(recovered.tasks[0].messages).toHaveLength(1)
    expect(recovered.tasks[0].messages[0]).toMatchObject({ kind: 'reasoning', text: 'Check the context.', streaming: false })
  })

  it.each([['Public answer'], ['First public segment', 'Second public segment']])('migrates an older saved Claude result without duplicating replayed deltas: %j', (...parts) => {
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
    task.events = [f.stream(start('partial')), f.stream(textBlock()), f.stream(delta('Public part'))]
    task.messages = [
      { id: `runtime:run:${f.member.id}:result:complete`, role: 'assistant', runId: 'run', memberId: f.member.id, text: 'Public part and missing continuation', createdAt: task.createdAt },
      { id: 'runtime:run:other:result:other', role: 'assistant', runId: 'run', memberId: 'other', text: 'Public part', createdAt: task.createdAt },
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
      for (let index = 0; index < 100; index++) state = applyRuntimeEvent(state, f.stream(delta('x')))
      expect(state.tasks[0].messages[0].text).toBe('x'.repeat(100))
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
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Search results' } }))
    expect(state.tasks[0].messages[0]).toMatchObject({ text: 'Search results', streaming: false })
    state = applyRuntimeEvent(state, f.json({ type: 'turn.completed', usage: {} }))
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0]).phase).toBe('waiting')
    const terminal = f.event('completed')
    state = applyRuntimeEvent(state, terminal)
    expect(getRunActivity(state.tasks[0], state.tasks[0].runs[0])).toMatchObject({ phase: 'completed', lastEventAt: terminal.timestamp })
  })

  it('handles public Codex item snapshots while keeping reasoning and raw command arguments out of summaries', () => {
    const f = fixture('codex')
    let state = applyRuntimeEvent(f.state, f.json({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Public' } }))
    state = applyRuntimeEvent(state, f.json({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Public result' } }))
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
