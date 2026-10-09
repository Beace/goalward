import { describe, expect, it } from 'vitest'
import { createInitialState, createTask } from './domain'
import { getTraceDisplayEntries } from './trace-calls'
import type { Adapter, RuntimeEvent } from './types'

function fixture(adapter: Adapter = 'codex') {
  const initial = createInitialState()
  const task = createTask(initial.settings, 'Tool calls', '/tmp/trace', 'solo')
  const member = task.members[0]
  task.runs = [{ id: 'run', createdAt: task.createdAt, prompt: 'test', directory: task.directory, members: [{ ...member, runtime: { ...initial.settings.runtimes[0], adapter }, model: '', status: 'running' }] }]
  let sequence = 0
  const event = (kind: RuntimeEvent['kind'], text = '', overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    id: `event-${++sequence}`, taskId: task.id, runId: 'run', memberId: member.id, timestamp: `2026-09-16T03:00:${String(sequence).padStart(2, '0')}Z`, kind, text, ...overrides,
  })
  const json = (payload: unknown, overrides?: Partial<RuntimeEvent>) => event('stdout', JSON.stringify(payload) + '\n', overrides)
  const append = (...events: RuntimeEvent[]) => { task.events.push(...events); return getTraceDisplayEntries(task) }
  const stream = (payload: unknown, parent?: string) => json({ type: 'stream_event', event: payload, parent_tool_use_id: parent })
  return { task, member, event, json, stream, append }
}
const search = (type: string, id: string, details: object = {}) => ({ type, item: { id, type: 'web_search', ...details } })
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: unknown, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error })

describe('shared trace projection', () => {
  it('reuses the same history for artifacts and run views, invalidating for new events and recovered status', () => {
    const f = fixture()
    f.task.events = [f.json(search('item.started', 'call'))]
    const all = getTraceDisplayEntries(f.task)
    expect(getTraceDisplayEntries({ ...f.task, title: 'Renamed' })).toBe(all)
    const scoped = getTraceDisplayEntries(f.task, f.task.runs[0])
    expect(scoped).toEqual(all)
    expect(scoped[0]).toBe(all[0])
    expect(getTraceDisplayEntries(f.task, f.task.runs[0])).toBe(scoped)
    const interrupted = { ...f.task, runs: f.task.runs.map(run => ({ ...run, members: run.members.map(member => ({ ...member, status: 'interrupted' as const })) })) }
    expect(getTraceDisplayEntries(interrupted)[0].call?.status).toBe('incomplete')
    expect(all[0].call?.status).toBe('running')
    const done = { ...f.task, events: [...f.task.events, f.json(search('item.completed', 'call'))] }
    expect(getTraceDisplayEntries(done)[0].call?.status).toBe('completed')
    expect(all[0].call?.records).toHaveLength(1)
  })

  it('keeps every source record in order for a tool with thousands of updates', () => {
    const f = fixture()
    const item = { id: 'long-call', type: 'command_execution', command: 'fixture' }
    f.task.events = Array.from({ length: 6000 }, (_, index) => f.json({ type: index === 5999 ? 'item.completed' : 'item.updated', item: { ...item, aggregated_output: `chunk ${index}` } }))
    const entry = getTraceDisplayEntries(f.task)[0]
    expect(entry.sourceIds).toEqual(f.task.events.map(event => event.id))
    expect(entry.call?.records.map(record => record.text)).toEqual(f.task.events.map(event => event.text))
    expect(entry.call).toMatchObject({ status: 'completed', output: { aggregated_output: 'chunk 5999' } })
  })

  it('refreshes the projection when the same bytes use a different adapter or member route', () => {
    const f = fixture()
    f.task.events = [f.json(search('item.started', 'call'))]
    expect(getTraceDisplayEntries(f.task)[0].call).toBeDefined()
    f.task.runs[0].members[0].runtime.adapter = 'generic'
    expect(getTraceDisplayEntries(f.task)[0].call).toBeUndefined()
    f.task.runs[0].members[0].runtime.adapter = 'codex'
    f.task.runs[0].members[0].id = 'different'
    expect(getTraceDisplayEntries(f.task)[0].call).toBeUndefined()
  })
})

describe('Codex tool call projection', () => {
  it('combines the reported web search lifecycle without presenting query metadata as search results', () => {
    const f = fixture()
    const started = f.json(search('item.started', 'item_8', { query: '', action: { type: 'other' } }))
    const initial = f.append(started)[0]
    expect(initial.call).toMatchObject({ status: 'running', startedAt: started.timestamp })
    const completed = f.json(search('item.completed', 'item_8', { query: 'AI news', action: { type: 'search', queries: ['AI news'] } }))
    const entries = f.append(completed)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: initial.id, title: '网页搜索', phase: '完成', summary: 'AI news', severity: 'success', sourceIds: [started.id, completed.id] })
    expect(entries[0].call).toMatchObject({ id: 'item_8', status: 'completed', startedAt: started.timestamp, endedAt: completed.timestamp, input: { query: 'AI news', action: { type: 'search', queries: ['AI news'] } }, outputNote: '运行时已报告搜索完成，但未提供搜索结果正文。' })
    expect(entries[0].call?.output).toBeUndefined()
    expect(entries[0].call?.records.map(record => record.text)).toEqual([started.text, completed.text])
    expect(f.task.events).toEqual([started, completed])
    expect(initial.call?.status).toBe('running')
  })

  it('retains the first row through command updates and separates input from a failed exit', () => {
    const f = fixture()
    const item = { id: 'command', type: 'command_execution', command: 'false' }
    const first = f.append(f.json({ type: 'item.started', item }))[0]
    const updated = f.append(f.json({ type: 'item.updated', item: { ...item, aggregated_output: 'partial' } }))[0]
    expect(updated.call).toMatchObject({ status: 'running', input: { command: 'false' }, output: { aggregated_output: 'partial' } })
    const done = f.append(f.json({ type: 'item.completed', item: { ...item, aggregated_output: 'failed command', exit_code: 1 } }))[0]
    expect(done).toMatchObject({ id: first.id, phase: '失败', severity: 'error' })
    expect(done.call).toMatchObject({ status: 'failed', input: { command: 'false' }, output: { aggregated_output: 'failed command', exit_code: 1 } })
    expect(done.call?.records).toHaveLength(3)
  })

  it('retains observed output when completion only supplies exit status, and respects explicit replacements', () => {
    const f = fixture()
    const item = { id: 'sparse', type: 'command_execution', command: 'pwd' }
    const entries = f.append(
      f.json({ type: 'item.started', item }),
      f.json({ type: 'item.updated', item: { id: item.id, type: item.type, aggregated_output: '/tmp\n', stderr: 'old warning' } }),
      f.json({ type: 'item.completed', item: { id: item.id, type: item.type, exit_code: 0, stderr: null } }),
    )
    expect(entries[0].call).toMatchObject({ status: 'completed', input: { command: 'pwd' }, output: { aggregated_output: '/tmp\n', exit_code: 0, stderr: null } })
  })

  it('never merges concurrent calls by tool type, query, member, or run', () => {
    const f = fixture()
    const other = { ...f.task.runs[0].members[0], id: 'other' }
    f.task.runs[0].members.push(other)
    f.task.runs.push({ ...f.task.runs[0], id: 'run-2' })
    const entries = f.append(
      f.json(search('item.started', 'same', { query: 'same query' })),
      f.json(search('item.started', 'parallel', { query: 'same query' })),
      f.json(search('item.started', 'same'), { memberId: other.id }),
      f.json(search('item.started', 'same'), { runId: 'run-2' }),
      f.json(search('item.completed', 'same')),
      f.json(search('item.completed', 'parallel')),
    )
    expect(entries).toHaveLength(4)
    expect(entries.map(entry => entry.call?.status)).toEqual(['completed', 'completed', 'running', 'running'])
    expect(getTraceDisplayEntries(f.task, f.task.runs[0])).toHaveLength(3)
  })

  it('leaves missing IDs and non-tool item events ungrouped', () => {
    const f = fixture()
    const entries = f.append(
      f.json({ type: 'item.started', item: { type: 'web_search', query: 'AI' } }),
      f.json({ type: 'item.completed', item: { type: 'web_search', query: 'AI' } }),
      f.json({ type: 'item.started', item: { id: 'message', type: 'agent_message', text: 'hello' } }),
      f.json({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'hello world' } }),
    )
    expect(entries).toHaveLength(4)
    expect(entries.every(entry => entry.call === undefined)).toBe(true)
  })

  it('groups fragmented JSON frames losslessly and keeps first-byte IDs', () => {
    const f = fixture()
    const start = JSON.stringify(search('item.started', 'split', { query: 'AI' }))
    const first = f.event('stdout', start.slice(0, 25))
    const partial = f.append(first)[0]
    const rest = f.event('stdout', start.slice(25) + '\n' + JSON.stringify(search('item.completed', 'split')) + '\n')
    const entry = f.append(rest)[0]
    expect(entry.id).toBe(partial.id)
    expect(entry.call?.status).toBe('completed')
    expect(entry.call?.records.map(record => record.text).join('')).toBe(first.text + rest.text)
    expect(entry.sourceIds).toEqual([first.id, rest.id])
  })

  it.each(['completed', 'failed', 'interrupted', 'stopped'] as const)('does not load forever after a %s member with no tool result', status => {
    const f = fixture()
    f.append(f.json(search('item.started', 'pending')))
    f.task.runs[0].members[0].status = status
    const entry = getTraceDisplayEntries(f.task)[0]
    expect(entry.call?.status).toBe(status === 'stopped' ? 'stopped' : 'incomplete')
    expect(entry.call?.output).toBeUndefined()
    expect(entry.call?.outputNote).toContain('未收到')
    expect(entry.severity).toBe('neutral')
  })

  it('honors a terminal process event even before run state catches up', () => {
    const f = fixture()
    f.append(f.json(search('item.started', 'pending')))
    const stop = f.event('stopped')
    const entries = f.append(stop)
    expect(entries[0].call).toMatchObject({ status: 'stopped', endedAt: stop.timestamp })
    expect(entries[1]).toMatchObject({ category: 'runtime', kind: 'stopped' })
  })

  it('shows orphan completions with their exact input/output, without inventing a start time', () => {
    const f = fixture()
    const entry = f.append(f.json({ type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: { name: 'Tauri' }, result: { content: [{ text: 'found' }] } } }))[0]
    expect(entry.call).toMatchObject({ status: 'completed', input: { name: 'Tauri' }, output: { result: { content: [{ text: 'found' }] } } })
    expect(entry.call?.startedAt).toBeUndefined()
  })

  it('preserves explicit null arguments and distinguishes them from missing input/output', () => {
    const f = fixture()
    const entries = f.append(
      f.json({ type: 'item.completed', item: { id: 'null', type: 'mcp_tool_call', arguments: null, input: { ignored: true }, result: null } }),
      f.json({ type: 'item.completed', item: { id: 'missing', type: 'mcp_tool_call' } }),
    )
    expect(entries[0].call).toMatchObject({ input: null, output: { result: null } })
    expect(entries[0].call?.inputNote).toBeUndefined()
    expect(entries[0].call?.outputNote).toBeUndefined()
    expect(entries[1].call).toMatchObject({ inputNote: '运行时未提供此工具的入参。', outputNote: '运行时未提供此工具的出参。' })
  })

  it('does not leave a stale missing-result note when delayed result evidence arrives', () => {
    const f = fixture()
    f.append(f.json(search('item.started', 'late')), f.json({ type: 'turn.failed' }))
    expect(getTraceDisplayEntries(f.task)[0].call?.status).toBe('incomplete')
    const entry = f.append(f.json(search('item.completed', 'late', { results: [] })))[0]
    expect(entry.call).toMatchObject({ status: 'completed', output: { results: [] } })
    expect(entry.call?.outputNote).toBeUndefined()
  })
})

describe('Claude tool call projection', () => {
  it('merges text deltas for one message index and keeps later messages separate', () => {
    const f = fixture('claude')
    const started = f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    const messageStarted = f.stream({ type: 'message_start', message: { id: 'message-one' } })
    const first = f.append(messageStarted, started)
      .find(entry => entry.message)!
    expect(first).toMatchObject({ title: '生成回复', phase: '进行中', sourceIds: [messageStarted.id, started.id] })
    const entries = f.append(
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ':' } }),
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '方案' } }),
      f.stream({ type: 'content_block_stop', index: 1 }),
      f.json({ type: 'assistant', message: { id: 'message-one', content: [{ type: 'thinking', thinking: '分析' }, { type: 'text', text: ':方案' }] } }),
      f.stream({ type: 'message_stop' }),
      f.stream({ type: 'message_start', message: { id: 'message-two' } }),
      f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '下一条' } }),
    )
    const messages = entries.filter(entry => entry.message)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: first.id, phase: '完成', severity: 'success', summary: ':方案' })
    expect(messages[0].message).toMatchObject({ text: ':方案', status: 'completed' })
    expect(messages[0].message?.records).toHaveLength(7)
    expect(messages[1]).toMatchObject({ phase: '进行中', summary: '下一条' })
    expect(messages[1].message).toMatchObject({ text: '下一条', status: 'running' })
  })

  it('groups orphan text deltas by index within a parent tool scope', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '父级' } }, 'parent'),
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回复' } }, 'parent'),
      f.stream({ type: 'content_block_stop', index: 1 }, 'parent'),
      f.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '顶层' } }),
    )
    const messages = entries.filter(entry => entry.message)
    expect(messages).toHaveLength(2)
    expect(messages.map(entry => entry.message?.text)).toEqual(['父级回复', '顶层'])
    expect(messages.map(entry => entry.message?.records.length)).toEqual([3, 1])
  })

  it('merges one thinking block, token estimates and the final duplicate into one stable reasoning row', () => {
    const f = fixture('claude')
    const started = f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    const messageStarted = f.stream({ type: 'message_start', message: { id: 'message-thinking' } })
    const first = f.append(messageStarted, started)
      .find(entry => entry.reasoning)!
    expect(first).toMatchObject({ title: '思考过程', phase: '进行中', sourceIds: [messageStarted.id, started.id] })
    const entries = f.append(
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先检查' } }),
      f.json({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 4, estimated_tokens_delta: 4 }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '上下文。' } }),
      f.json({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 7, estimated_tokens_delta: 3 }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
      f.json({ type: 'assistant', message: { id: 'message-thinking', content: [{ type: 'thinking', thinking: '先检查上下文。' }] } }),
    )
    const reasoning = entries.filter(entry => entry.reasoning)
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ id: first.id, phase: '完成', severity: 'success', summary: '先检查上下文。' })
    expect(reasoning[0].reasoning).toMatchObject({ text: '先检查上下文。', status: 'completed', estimatedTokens: 7 })
    expect(reasoning[0].reasoning?.records).toHaveLength(9)
    expect(reasoning[0].sourceIds).toEqual([messageStarted.id, started.id, ...f.task.events.slice(2).map(event => event.id)])
    expect(reasoning[0].reasoning?.text).not.toContain('PRIVATE_SIGNATURE')
  })

  it('assembles streamed arguments, enriches the full duplicate, and completes only on a tool result', () => {
    const f = fixture('claude')
    const first = f.append(f.stream({ type: 'content_block_start', index: 0, content_block: use('search', 'WebSearch', {}) }))[0]
    const partial = f.append(f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } }))[0]
    expect(partial.call).toMatchObject({ status: 'running', input: '{"query":', inputNote: '工具参数尚未完整接收，显示已收到的原文。' })
    const stopped = f.append(
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"AI news"}' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
      f.json({ type: 'assistant', message: { content: [use('search', 'WebSearch', { query: 'AI news', limit: 2 })] } }),
    )
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({ id: first.id, category: 'web-search', phase: '执行中', summary: 'AI news' })
    expect(stopped[0].call).toMatchObject({ status: 'running', input: { query: 'AI news', limit: 2 } })
    expect(stopped[0].call?.inputNote).toBeUndefined()
    const output = [{ type: 'text', text: 'two results' }]
    const done = f.append(f.json({ type: 'user', message: { content: [result('search', output)] } }))
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ id: first.id, category: 'web-search', title: '网页搜索', phase: '完成', severity: 'success' })
    expect(done[0].call).toMatchObject({ status: 'completed', output })
    expect(done[0].call?.records).toHaveLength(6)
  })

  it('splits multiple tools in one message and matches reversed result order by ID', () => {
    const f = fixture('claude')
    const request = f.json({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will inspect both.' }, use('a', 'Bash', { command: 'pwd' }), use('b', 'Read', { file_path: 'README.md' })] } })
    const entries = f.append(request, f.json({ type: 'user', message: { content: [result('b', 'read failed', true), result('a', '/tmp/trace')] } }))
    const calls = entries.filter(entry => entry.call)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3)
    expect(calls.map(entry => [entry.call?.id, entry.call?.status, entry.call?.output])).toEqual([['a', 'completed', '/tmp/trace'], ['b', 'failed', 'read failed']])
    expect(calls[0]).toMatchObject({ category: 'command', summary: 'pwd' })
    expect(calls[1]).toMatchObject({ category: 'tool', summary: 'Read', severity: 'error' })
    expect(entries.find(entry => entry.category === 'message')?.summary).toBe('I will inspect both.')
    expect(calls.every(entry => entry.call?.records[0].text === request.text)).toBe(true)
  })

  it('isolates stream indices across messages and subagent parents', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.stream({ type: 'content_block_start', index: 0, content_block: use('top', 'Bash', {}) }),
      f.stream({ type: 'content_block_start', index: 0, content_block: use('child', 'Read', {}) }, 'parent'),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"child.txt"}' } }, 'parent'),
      f.stream({ type: 'message_stop' }),
      f.stream({ type: 'message_start', message: { id: 'new-message' } }),
      f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"must not attach"}' } }),
      f.json({ type: 'result', subtype: 'success', parent_tool_use_id: 'parent' }),
    )
    const calls = entries.filter(entry => entry.call)
    expect(calls[0].call).toMatchObject({ id: 'top', status: 'running', input: {} })
    expect(calls[1].call).toMatchObject({ id: 'child', status: 'incomplete', input: { file_path: 'child.txt' } })
    expect(entries.some(entry => !entry.call && entry.text.includes('must not attach'))).toBe(true)
  })

  it('does not mix duplicate call IDs across Claude members and runs', () => {
    const f = fixture('claude')
    const other = { ...f.task.runs[0].members[0], id: 'other' }
    f.task.runs[0].members.push(other)
    f.task.runs.push({ ...f.task.runs[0], id: 'run-2' })
    const request = { type: 'assistant', message: { content: [use('same', 'Bash', { command: 'pwd' })] } }
    const entries = f.append(f.json(request), f.json(request, { memberId: 'other' }), f.json(request, { runId: 'run-2' }), f.json({ type: 'user', message: { content: [result('same', '/tmp')] } }, { memberId: 'other' }))
    expect(entries).toHaveLength(3)
    expect(entries.map(entry => entry.call?.status)).toEqual(['running', 'completed', 'running'])
  })

  it('preserves unmatched/missing-ID tool records instead of guessing from names', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.json({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] } }),
      f.json({ type: 'user', message: { content: [result('orphan', '/tmp')] } }),
    )
    expect(entries).toHaveLength(2)
    expect(entries[0].call).toBeUndefined()
    expect(entries[1].call).toMatchObject({ id: 'orphan', status: 'completed', output: '/tmp', inputNote: '运行时未提供此工具的入参。' })
    expect(entries[1].call?.startedAt).toBeUndefined()
  })

  it('enriches a duplicated assistant request without reverting a completed result', () => {
    const f = fixture('claude')
    const request = { type: 'assistant', message: { content: [use('tool', 'Read', { file_path: 'file.txt' })] } }
    const entries = f.append(f.json(request), f.json({ type: 'user', message: { content: [result('tool', null)] } }), f.json(request))
    expect(entries).toHaveLength(1)
    expect(entries[0].call).toMatchObject({ status: 'completed', output: null, input: { file_path: 'file.txt' } })
    expect(entries[0].call?.outputNote).toBeUndefined()
    expect(entries[0].call?.records).toHaveLength(3)
  })

  it('does not invent a start later than an already-observed orphan result', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.json({ type: 'user', message: { content: [result('delayed', 'contents')] } }),
      f.json({ type: 'assistant', message: { content: [use('delayed', 'Read', { file_path: 'file.txt' })] } }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].call).toMatchObject({ status: 'completed', input: { file_path: 'file.txt' }, output: 'contents' })
    expect(entries[0].call?.startedAt).toBeUndefined()
  })

  it('pairs server web search input and empty successful results in one full assistant message', () => {
    const f = fixture('claude')
    const entries = f.append(f.json({ type: 'assistant', message: { content: [
      { ...use('search-server', 'web_search', { query: 'AI' }), type: 'server_tool_use' },
      { type: 'web_search_tool_result', tool_use_id: 'search-server', content: [] },
    ] } }))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ category: 'web-search', title: '网页搜索', severity: 'success' })
    expect(entries[0].call).toMatchObject({ status: 'completed', input: { query: 'AI' }, output: [] })
    expect(entries[0].call?.outputNote).toBeUndefined()
    expect(entries[0].call?.records).toHaveLength(1)
  })

  it('groups streamed web fetch result boundaries and marks an explicit server error as failed', () => {
    const f = fixture('claude')
    const error = { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' }
    const entries = f.append(
      f.stream({ type: 'content_block_start', index: 0, content_block: { ...use('fetch-server', 'web_fetch', { url: 'https://example.com' }), type: 'server_tool_use' } }),
      f.stream({ type: 'content_block_stop', index: 0 }),
      f.stream({ type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', tool_use_id: 'fetch-server', content: error } }),
      f.stream({ type: 'content_block_stop', index: 1 }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ category: 'web-search', title: '读取网页', severity: 'error', phase: '失败' })
    expect(entries[0].call).toMatchObject({ status: 'failed', input: { url: 'https://example.com' }, output: error })
    expect(entries[0].call?.records).toHaveLength(4)
  })

  it.each([
    ['web_search_tool_result', '网页搜索', { type: 'web_search_tool_result_error', error_code: 'too_many_requests' }, 'failed'],
    ['web_fetch_tool_result', '读取网页', { type: 'web_fetch_result', url: 'https://example.com', content: { type: 'document', title: 'Example' } }, 'completed'],
  ] as const)('recognizes orphan %s results without inventing their inputs or start time', (type, title, content, status) => {
    const f = fixture('claude')
    const entry = f.append(f.json({ type: 'assistant', message: { content: [{ type, tool_use_id: 'orphan-server', content }] } }))[0]
    expect(entry).toMatchObject({ category: 'web-search', title })
    expect(entry.call).toMatchObject({ status, output: content, inputNote: '运行时未提供此工具的入参。' })
    expect(entry.call?.startedAt).toBeUndefined()
  })

  it('keeps unsupported server-result block protocols visible without inventing a completion', () => {
    const f = fixture('claude')
    const entries = f.append(
      f.json({ type: 'assistant', message: { content: [{ ...use('server', 'web_search', { query: 'AI' }), type: 'server_tool_use' }] } }),
      f.json({ type: 'assistant', message: { content: [{ type: 'future_tool_result', tool_use_id: 'server', content: 'opaque' }] } }),
      f.json({ type: 'result', subtype: 'success' }),
    )
    expect(entries).toHaveLength(3)
    expect(entries[0].call).toMatchObject({ id: 'server', status: 'incomplete', input: { query: 'AI' } })
    expect(entries[1].text).toContain('future_tool_result')
    expect(entries[1].call).toBeUndefined()
  })
})
