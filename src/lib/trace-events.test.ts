import { describe, expect, it } from 'vitest'
import { createInitialState, createTask } from './domain'
import { getTraceEntries } from './trace-events'
import type { Adapter, RuntimeEvent } from './types'

function fixture(adapter: Adapter = 'codex') {
  const initial = createInitialState()
  const task = createTask(initial.settings, 'Trace 分类', '/tmp/trace', 'solo')
  const member = task.members[0]
  task.runs = [{ id: 'run', createdAt: task.createdAt, prompt: 'test', directory: task.directory, members: [{ ...member, runtime: { ...initial.settings.runtimes[0], adapter }, model: '', status: 'running' }] }]
  let sequence = 0
  const event = (kind: RuntimeEvent['kind'], text = '', overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    id: `event-${++sequence}`, taskId: task.id, runId: 'run', memberId: member.id, timestamp: `2026-09-16T03:00:${String(sequence).padStart(2, '0')}Z`, kind, text, ...overrides,
  })
  const json = (payload: unknown, overrides?: Partial<RuntimeEvent>) => event('stdout', JSON.stringify(payload) + '\n', overrides)
  const append = (...events: RuntimeEvent[]) => { task.events = [...task.events, ...events]; return getTraceEntries(task, task.runs[0]) }
  const stream = (payload: unknown) => json({ type: 'stream_event', event: payload })
  return { task, event, json, append, stream, member }
}

describe('trace types', () => {
  it('classifies the reported Codex search start and completion from historical JSON without changing raw records', () => {
    const f = fixture()
    const events = [
      f.json({ type: 'item.started', item: { id: 'search', type: 'web_search', query: '', action: { type: 'other' } } }),
      f.json({ type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'AI news', action: { type: 'search', queries: ['AI news'] } } }),
    ]
    const before = JSON.stringify(events)
    const entries = f.append(...events)
    expect(entries.map(entry => [entry.title, entry.phase, entry.severity])).toEqual([['网页搜索', '开始', 'neutral'], ['网页搜索', '完成', 'success']])
    expect(entries[1]).toMatchObject({ eventType: 'item.completed / web_search', summary: 'AI news', text: events[1].text, sourceIds: [events[1].id] })
    expect(JSON.stringify(f.task.events)).toBe(before)
  })

  it.each([
    ['agent_message', { text: '**答复**' }, 'message', '生成回复', '**答复**'],
    ['reasoning', { text: 'DO_NOT_SUMMARIZE' }, 'reasoning', '思考状态', undefined],
    ['command_execution', { command: 'pwd', exit_code: 0 }, 'command', '执行命令', 'pwd'],
    ['file_change', { changes: [{ path: 'src/main.ts', kind: 'update' }] }, 'file-change', '文件变更', 'src/main.ts'],
    ['mcp_tool_call', { server: 'docs', tool: 'search' }, 'tool', '调用 MCP 工具', 'docs · search'],
    ['collab_tool_call', { tool: 'spawn_agent' }, 'tool', 'Agent 协作', 'spawn_agent'],
  ])('uses Codex %s metadata', (type, data, category, title, summary) => {
    const f = fixture()
    const entry = f.append(f.json({ type: 'item.completed', item: { type, ...data as object } }))[0]
    expect(entry).toMatchObject({ category, title, phase: '完成' })
    expect(entry.summary).toBe(summary)
  })

  it('recognizes structured failure instead of marking completed transport envelopes successful', () => {
    const f = fixture()
    const entries = f.append(
      f.json({ type: 'item.completed', item: { type: 'error', message: 'Skill descriptions were shortened' } }),
      f.json({ type: 'item.completed', item: { type: 'command_execution', command: 'false', exit_code: 1 } }),
      f.json({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed' } }),
      f.json({ type: 'turn.failed', error: { message: 'connection closed' } }),
      f.json({ type: 'error', message: 'network failed' }),
    )
    expect(entries.every(entry => entry.severity === 'error' && entry.phase === '失败')).toBe(true)
    expect(entries[0]).toMatchObject({ category: 'diagnostic', title: 'Runtime 错误', summary: 'Skill descriptions were shortened' })
    expect(entries[3].summary).toBe('connection closed')
  })

  it('separates sessions, turns and process lifecycle', () => {
    const f = fixture()
    const entries = f.append(f.event('started', 'process started'), f.json({ type: 'thread.started' }), f.json({ type: 'turn.started' }), f.json({ type: 'turn.completed' }), f.event('completed', 'done', { exitCode: 0 }))
    expect(entries.map(entry => [entry.category, entry.title])).toEqual([['runtime', '启动 Runtime'], ['session', '创建会话'], ['turn', '执行轮次'], ['turn', '执行轮次'], ['runtime', '执行完成']])
    expect(entries.at(-1)).toMatchObject({ exitCode: 0, severity: 'success' })
  })

  it('does not label ordinary stderr as an error, but honors an explicit structured error', () => {
    const f = fixture()
    const entries = f.append(f.event('stderr', 'Reading additional input from stdin...\n'), f.event('stderr', '{"level":"error","message":"failed"}\n'))
    expect(entries[0]).toMatchObject({ category: 'diagnostic', title: '诊断输出', severity: 'neutral' })
    expect(entries[1]).toMatchObject({ category: 'diagnostic', severity: 'error', summary: 'failed' })
  })

  it('keeps unknown protocol types visible and retains generic output verbatim', () => {
    const f = fixture()
    const entries = f.append(f.json({ type: 'item.completed', item: { type: 'new_runtime_item' } }), f.json({ type: 'future.event' }), f.event('stdout', 'plain output\n'), f.event('stdout', '{broken}\n'))
    expect(entries[0]).toMatchObject({ category: 'unknown', eventType: 'item.completed / new_runtime_item', phase: '完成' })
    expect(entries[1].title).toContain('future.event')
    expect(entries[2]).toMatchObject({ title: '标准输出', text: 'plain output\n' })
    expect(entries[3]).toMatchObject({ category: 'diagnostic', text: '{broken}\n', severity: 'neutral' })
    const generic = fixture('generic')
    const raw = 'one\ntwo\n'
    expect(generic.append(generic.event('stdout', raw))).toHaveLength(1)
    expect(getTraceEntries(generic.task)[0].text).toBe(raw)
  })
})

describe('trace stream framing', () => {
  it('replaces a pending fragment using the same ID and keeps every raw byte and provenance', () => {
    const f = fixture()
    const first = f.event('stdout', '{"type":"item.started","item":')
    const pending = f.append(first)
    expect(pending[0]).toMatchObject({ phase: '接收中', text: first.text, sourceIds: [first.id] })
    // A complete nested object is a genuine fragment, not a separate JSON event.
    const nested = f.event('stdout', '{"type":"web_search","query":"AI"}')
    const second = f.append(nested)
    expect(second).toHaveLength(1)
    const tail = f.event('stdout', '}\r\n')
    const complete = f.append(tail)
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ id: pending[0].id, title: '网页搜索', phase: '开始', text: first.text + nested.text + tail.text, sourceIds: [first.id, nested.id, tail.id] })
    expect(pending[0].text).toBe(first.text)
    expect(pending[0].phase).toBe('接收中')
  })

  it('splits several JSONL frames per chunk with stable offset IDs and lossless raw text', () => {
    const f = fixture()
    const raw = ' {"type":"thread.started"}\r\n{"type":"turn.started"}\n{"type":"turn.completed"}'
    const event = f.event('stdout', raw)
    const entries = f.append(event)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3)
    expect(entries.map(entry => entry.text).join('')).toBe(raw)
    expect(entries.every(entry => entry.sourceIds[0] === event.id)).toBe(true)
    const newline = f.event('stdout', '\n')
    const next = f.append(newline)
    expect(next).toHaveLength(3)
    expect(next[2].id).toBe(entries[2].id)
    expect(next[2].sourceIds).toEqual([event.id, newline.id])
    expect(next.map(entry => entry.text).join('')).toBe(raw + '\n')
  })

  it('supports older one-record-per-event logs without newline delimiters', () => {
    const f = fixture()
    const entries = f.append(f.event('stdout', '{"type":"thread.started"}'), f.event('stdout', '{"type":"turn.started"}'))
    expect(entries.map(entry => entry.category)).toEqual(['session', 'turn'])
  })

  it('isolates fragmented routes by run, member, and channel while preserving first-byte order', () => {
    const f = fixture()
    const other = { ...f.task.runs[0].members[0], id: 'other' }
    f.task.runs[0].members.push(other)
    f.task.runs.push({ ...f.task.runs[0], id: 'other-run' })
    const entries = f.append(
      f.event('stdout', '{"type":"item.started","item":'),
      f.json({ type: 'turn.started' }, { memberId: other.id }),
      f.event('stderr', 'diagnostic\n'),
      f.json({ type: 'thread.started' }, { runId: 'other-run' }),
      f.event('stdout', '{"type":"web_search"}}\n'),
    )
    expect(entries.map(entry => entry.title)).toEqual(['网页搜索', '执行轮次', '诊断输出'])
    expect(entries[0].sourceIds).toHaveLength(2)
    expect(getTraceEntries(f.task)).toHaveLength(4)
  })

  it.each(['completed', 'failed', 'stopped'] as const)('flushes incomplete bytes when the process %s', kind => {
    const f = fixture()
    const entries = f.append(f.event('stdout', '{"type":"item.'), f.event(kind))
    expect(entries[0]).toMatchObject({ category: 'diagnostic', phase: undefined, text: '{"type":"item.' })
    expect(entries[1].kind).toBe(kind)
  })

  it('flushes a recovered interrupted run without a terminal event', () => {
    const f = fixture()
    f.append(f.event('stdout', '{"type":'))
    f.task.runs[0].members[0].status = 'interrupted'
    expect(getTraceEntries(f.task)[0]).toMatchObject({ category: 'diagnostic', phase: undefined })
  })

  it('retains a malformed abandoned frame and classifies the following independent record', () => {
    const f = fixture()
    const entries = f.append(f.event('stdout', '{malformed'), f.json({ type: 'turn.started' }))
    expect(entries.map(entry => entry.category)).toEqual(['diagnostic', 'turn'])
    expect(entries[0].text).toBe('{malformed')
  })

  it('clears the receiving phase when a fragmented unknown event becomes complete', () => {
    const f = fixture()
    f.append(f.event('stdout', '{\"type\":\"future'))
    const entries = f.append(f.event('stdout', '.event\"}\n'))
    expect(entries[0]).toMatchObject({ category: 'unknown', eventType: 'future.event', phase: undefined })
  })

  it('bounds an unfinished frame without discarding its text', () => {
    const f = fixture()
    const raw = '{' + ' '.repeat(4 * 1024 * 1024)
    expect(f.append(f.event('stdout', raw))[0]).toMatchObject({ category: 'diagnostic', phase: undefined, text: raw })
  })
})

describe('Claude trace classification', () => {
  it('classifies the streaming lifecycle and never summarizes private thinking or signatures', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.json({ type: 'system', subtype: 'init', model: 'model' }),
      f.stream({ type: 'message_start', message: { id: 'message' } }),
      f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE' } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
      f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '公开答复' } }),
      f.stream({ type: 'message_stop' }),
    )
    expect(entries[0]).toMatchObject({ title: '初始化会话', eventType: 'system / init' })
    expect(entries.slice(2, 6).every(entry => entry.category === 'reasoning' && entry.summary === undefined)).toBe(true)
    expect(entries[7]).toMatchObject({ title: '生成回复', phase: '进行中', summary: '公开答复' })
    expect(entries[8]).toMatchObject({ phase: '完成' })
    expect(entries.map(entry => entry.summary).join('')).not.toContain('PRIVATE')
    expect(entries.some(entry => entry.text.includes('PRIVATE'))).toBe(true)
  })

  it('distinguishes streamed tool parameters from completed tool execution', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'search', name: 'WebSearch', input: { query: 'AI news' } } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"secret input"}' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
      f.json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search', is_error: false, content: 'results' }] } }),
    )
    expect(entries.map(entry => [entry.title, entry.phase])).toEqual([['网页搜索', '开始'], ['工具参数', '进行中'], ['工具参数', '完成'], ['工具结果', '完成']])
    expect(entries[3]).toMatchObject({ summary: 'WebSearch', severity: 'success' })
    expect(entries.map(entry => entry.summary).join('')).not.toContain('secret input')
  })

  it('classifies full assistant replies, tool requests/results and result failures', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.json({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
      f.json({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'command', name: 'Bash', input: { command: 'pwd' } }] } }),
      f.json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'command', is_error: true }] } }),
      f.json({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failed' }),
      f.json({ type: 'result', subtype: 'success', result: 'answer' }),
    )
    expect(entries[0]).toMatchObject({ category: 'message', title: 'Agent 回复', summary: 'answer' })
    expect(entries[1]).toMatchObject({ category: 'command', title: '执行命令', summary: 'pwd' })
    expect(entries[2]).toMatchObject({ title: '工具结果', phase: '失败', summary: 'Bash', severity: 'error' })
    expect(entries[3]).toMatchObject({ title: '执行结果', phase: '失败', eventType: 'result / error_during_execution' })
    expect(entries[4]).toMatchObject({ title: '执行结果', phase: '完成' })
  })

  it('does not summarize a text-shaped delta belonging to a known thinking block', () => {
    const f = fixture('claude')
    const entries = f.append(f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }), f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE' } }))
    expect(entries[1].category).toBe('reasoning')
    expect(entries[1].summary).toBeUndefined()
  })

  it('shows unknown nested event types rather than hardcoding a known event label', () => {
    const f = fixture('claude')
    expect(f.append(f.stream({ type: 'content_block_delta', delta: { type: 'future_delta' } }))[0]).toMatchObject({ category: 'unknown', eventType: 'stream_event / content_block_delta / future_delta' })
  })
})
