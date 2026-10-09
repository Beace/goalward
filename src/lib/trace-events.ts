import type { Adapter, Run, RunMember, RuntimeEvent, Task } from './types'

type JsonObject = Record<string, unknown>
export type TraceCategory = 'runtime' | 'session' | 'turn' | 'message' | 'reasoning' | 'web-search' | 'command' | 'file-change' | 'tool' | 'result' | 'diagnostic' | 'output' | 'unknown'
export interface TraceEntry extends RuntimeEvent {
  category: TraceCategory
  title: string
  phase?: string
  severity: 'neutral' | 'success' | 'error'
  eventType?: string
  summary?: string
  sourceIds: string[]
}
type Description = Pick<TraceEntry, 'category' | 'title' | 'phase' | 'severity' | 'eventType' | 'summary'>
interface Block { type: string; name: string }
interface Pending { entry: TraceEntry; index: number; complete: boolean }
interface Stream { pending?: Pending; blocks: Map<number, Block>; tools: Map<string, string> }
const MAX_PENDING = 4 * 1024 * 1024
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const string = (value: unknown) => typeof value === 'string' ? value : ''
const concise = (value: string) => value.replace(/[\r\n\t\u0000-\u001f]+/g, ' ').trim().slice(0, 160) || undefined
const detail = (...values: unknown[]) => concise(values.map(string).filter(Boolean).join(' · '))
function parse(text: string): { valid: boolean; value?: JsonObject } {
  // Native reads often split a large JSON object across many chunks. Avoid
  // repeatedly parsing (and throwing on) a frame that cannot be closed yet.
  // This is only a rejection fast path: JSON.parse still validates all frames.
  const start = text.trimStart()[0]
  const end = text.trimEnd().at(-1)
  if (start === '{' && end !== '}' || start === '[' && end !== ']') return { valid: false }
  try { return { valid: true, value: object(JSON.parse(text)) } } catch { return { valid: false } }
}
function failed(value?: JsonObject) {
  return Boolean(value && (value.is_error === true || value.status === 'failed' || value.status === 'error'
    || value.status === 'errored' || (typeof value.exit_code === 'number' && value.exit_code !== 0)
    || (typeof value.exitCode === 'number' && value.exitCode !== 0)))
}
function phase(type: string, value?: JsonObject): Pick<Description, 'phase' | 'severity'> {
  if (failed(value) || /(?:^|[._])(?:failed|error)$/.test(type)) return { phase: '失败', severity: 'error' }
  if (/(?:^|[._])(?:completed|success)$/.test(type)) return { phase: '完成', severity: 'success' }
  if (/(?:^|[._])(?:started|start)$/.test(type)) return { phase: '开始', severity: 'neutral' }
  if (/(?:^|[._])(?:updated|delta)$/.test(type)) return { phase: '进行中', severity: 'neutral' }
  return { severity: 'neutral' }
}
function fallback(kind: RuntimeEvent['kind'], pending = false, malformed = false): Description {
  return { category: kind === 'stderr' || malformed ? 'diagnostic' : 'output', title: malformed ? '未完整解析的输出' : kind === 'stderr' ? '诊断输出' : '标准输出', phase: pending ? '接收中' : undefined, severity: 'neutral' }
}
function unknown(payload: JsonObject, path?: string): Description {
  const eventType = path || string(payload.type) || string(payload.event)
  return { category: 'unknown', title: eventType ? `事件：${concise(eventType)}` : '结构化输出', eventType: eventType || undefined, ...phase(string(payload.type), payload) }
}
function errorDescription(payload: JsonObject, eventType: string): Description {
  return { category: 'diagnostic', title: 'Runtime 错误', phase: '失败', severity: 'error', eventType,
    summary: detail(payload.message, object(payload.error)?.message, typeof payload.error === 'string' ? payload.error : '') }
}
function codex(payload: JsonObject): Description {
  const type = string(payload.type)
  const item = object(payload.item)
  if (type.startsWith('item.') && item) {
    const itemType = string(item.type)
    const eventType = [type, itemType].filter(Boolean).join(' / ')
    const state = phase(type, item)
    const base = { ...state, eventType }
    if (itemType === 'error') return errorDescription(item, eventType)
    if (itemType === 'agent_message') return { ...base, category: 'message', title: '生成回复', summary: concise(string(item.text)) }
    if (itemType === 'reasoning') return { ...base, category: 'reasoning', title: '思考状态' }
    if (itemType === 'web_search') {
      const action = object(item.action)
      const queries = Array.isArray(action?.queries) ? action.queries.map(string).filter(Boolean).join('；') : ''
      return { ...base, category: 'web-search', title: '网页搜索', summary: detail(item.query || action?.query || queries || action?.url) }
    }
    if (itemType === 'command_execution') return { ...base, category: 'command', title: '执行命令', summary: detail(item.command) }
    if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes.map(object).filter((change): change is JsonObject => Boolean(change)) : []
      return { ...base, category: 'file-change', title: '文件变更', summary: concise(changes.map(change => string(change.path)).filter(Boolean).join('、')) }
    }
    if (itemType === 'mcp_tool_call') return { ...base, category: 'tool', title: '调用 MCP 工具', summary: detail(item.server, item.tool) }
    if (itemType === 'collab_tool_call') return { ...base, category: 'tool', title: 'Agent 协作', summary: detail(item.tool) }
    if (itemType === 'todo_list') return { ...base, category: 'tool', title: '更新计划' }
    return { ...unknown(item, eventType), ...state }
  }
  if (type === 'thread.started') return { category: 'session', title: '创建会话', eventType: type, ...phase(type) }
  if (['turn.started', 'turn.completed', 'turn.failed'].includes(type)) return { category: 'turn', title: '执行轮次', eventType: type, ...phase(type, payload), summary: detail(object(payload.error)?.message) }
  if (type === 'error') return errorDescription(payload, type)
  return unknown(payload)
}
function toolDescription(name: string, input?: JsonObject): Pick<Description, 'category' | 'title' | 'summary'> {
  if (/^(WebSearch|WebFetch|web_search|web_fetch)$/.test(name)) return { category: 'web-search', title: /fetch/i.test(name) ? '读取网页' : '网页搜索', summary: detail(name, input?.query || input?.url) }
  if (/^(Bash|bash|shell|execute_command)$/.test(name)) return { category: 'command', title: '执行命令', summary: detail(input?.command || name) }
  if (/^(Write|Edit|write|edit|MultiEdit|NotebookEdit)$/.test(name)) return { category: 'file-change', title: '文件变更', summary: detail(name, input?.path || input?.file_path || input?.notebook_path) }
  return { category: 'tool', title: '调用工具', summary: detail(name) }
}
function rememberTool(stream: Stream, block: JsonObject) {
  const id = string(block.id)
  if (id) stream.tools.set(id, string(block.name))
}
function claude(payload: JsonObject, stream: Stream): Description {
  const type = string(payload.type)
  if (type === 'stream_event') {
    const event = object(payload.event)
    if (!event) return unknown(payload)
    const nested = string(event.type)
    const path = `stream_event / ${nested}`
    if (nested === 'message_start') { stream.blocks.clear(); return { category: 'message', title: '生成回复', phase: '开始', severity: 'neutral', eventType: path } }
    if (nested === 'message_stop') return { category: 'message', title: '生成回复', phase: '完成', severity: 'success', eventType: path }
    if (nested === 'message_delta') return { category: 'message', title: '回复状态', phase: '进行中', severity: 'neutral', eventType: path, summary: detail(object(event.delta)?.stop_reason) }
    if (nested === 'error') return errorDescription(event, path)
    if (nested === 'content_block_start') {
      const block = object(event.content_block)
      if (!block) return unknown(event, path)
      const blockType = string(block.type)
      if (typeof event.index === 'number') stream.blocks.set(event.index, { type: blockType, name: string(block.name) })
      const base = { eventType: `${path} / ${blockType}`, phase: '开始', severity: 'neutral' as const }
      if (blockType === 'text') return { ...base, category: 'message', title: '生成回复', summary: concise(string(block.text)) }
      if (blockType === 'thinking' || blockType === 'redacted_thinking') return { ...base, category: 'reasoning', title: '思考状态' }
      if (blockType === 'tool_use' || blockType === 'server_tool_use') { rememberTool(stream, block); return { ...base, ...toolDescription(string(block.name), object(block.input)) } }
      return unknown(block, base.eventType)
    }
    if (nested === 'content_block_delta') {
      const delta = object(event.delta)
      const deltaType = string(delta?.type)
      const block = typeof event.index === 'number' ? stream.blocks.get(event.index) : undefined
      const base = { eventType: `${path} / ${deltaType}`, phase: '进行中', severity: 'neutral' as const }
      if (deltaType === 'thinking_delta' || deltaType === 'signature_delta' || block?.type === 'thinking' || block?.type === 'redacted_thinking') return { ...base, category: 'reasoning', title: '思考状态' }
      if (deltaType === 'text_delta') return { ...base, category: 'message', title: '生成回复', summary: concise(string(delta?.text)) }
      if (deltaType === 'input_json_delta') return { ...base, category: 'tool', title: '工具参数', summary: detail(block?.name) }
      return unknown(delta ?? event, base.eventType)
    }
    if (nested === 'content_block_stop') {
      const block = typeof event.index === 'number' ? stream.blocks.get(event.index) : undefined
      const base = { eventType: [path, block?.type].filter(Boolean).join(' / '), phase: '完成', severity: 'success' as const }
      if (block?.type === 'text') return { ...base, category: 'message', title: '回复片段' }
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return { ...base, category: 'reasoning', title: '思考状态' }
      // Completing streamed arguments is not evidence that the tool has run.
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') return { ...base, category: 'tool', title: '工具参数', summary: detail(block.name) }
      return { ...base, category: 'unknown', title: '内容片段' }
    }
    return unknown(event, path)
  }
  if (type === 'assistant' || type === 'user') {
    const content = object(payload.message)?.content
    const blocks = Array.isArray(content) ? content.map(object).filter((block): block is JsonObject => Boolean(block)) : []
    const tools = blocks.filter(block => block.type === 'tool_use' || block.type === 'server_tool_use')
    tools.forEach(block => rememberTool(stream, block))
    if (tools.length) return { ...toolDescription(string(tools[0].name), object(tools[0].input)), phase: '开始', severity: 'neutral', eventType: `${type} / tool_use` }
    const results = blocks.filter(block => block.type === 'tool_result')
    if (results.length) return { category: 'tool', title: '工具结果', phase: results.some(failed) ? '失败' : '完成', severity: results.some(failed) ? 'error' : 'success', eventType: `${type} / tool_result`, summary: detail(...results.map(block => stream.tools.get(string(block.tool_use_id)))) }
    const text = typeof content === 'string' ? content : blocks.filter(block => block.type === 'text').map(block => string(block.text)).join(' ')
    if (!text && blocks.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')) return { category: 'reasoning', title: '思考状态', phase: '完成', severity: 'success', eventType: `${type} / thinking` }
    return { category: 'message', title: type === 'assistant' ? 'Agent 回复' : '用户消息', phase: '完成', severity: 'success', eventType: type, summary: concise(text) }
  }
  if (type === 'system') return { category: 'session', title: payload.subtype === 'init' ? '初始化会话' : '会话状态', eventType: ['system', string(payload.subtype)].filter(Boolean).join(' / '), phase: payload.subtype === 'init' ? '开始' : undefined, severity: 'neutral', summary: detail(payload.model) }
  if (type === 'result') {
    const failure = failed(payload) || string(payload.subtype).startsWith('error')
    return { category: 'result', title: '执行结果', phase: failure ? '失败' : '完成', severity: failure ? 'error' : 'success', eventType: ['result', string(payload.subtype)].filter(Boolean).join(' / '), summary: concise(string(payload.result)) }
  }
  if (type === 'error') return errorDescription(payload, type)
  return unknown(payload)
}
function kimi(payload: JsonObject): Description {
  const type = string(payload.type)
  if (type === 'kimi.session') return { category: 'session', title: payload.resumed ? '继续会话' : '创建会话', severity: 'neutral', eventType: type, summary: string(payload.sessionId) }
  if (type === 'kimi.permission_requested' || type === 'kimi.permission_resolved') return { category: 'tool', title: type === 'kimi.permission_requested' ? '等待工具权限确认' : '权限请求已处理', severity: 'neutral', eventType: type, summary: detail(object(payload.toolCall)?.title, payload.optionId) }
  if (type === 'kimi.prompt_completed') return { category: 'result', title: 'Kimi 执行结果', severity: payload.stopReason === 'end_turn' ? 'success' : 'neutral', eventType: type, summary: string(payload.stopReason) }
  const update = object(payload.update)
  if (type !== 'kimi.acp.update' || !update) return unknown(payload)
  const eventType = `kimi / ${string(update.sessionUpdate)}`
  if (update.sessionUpdate === 'agent_message_chunk') return { category: 'message', title: '生成回复', phase: '进行中', severity: 'neutral', eventType, summary: object(update.content)?.type === 'text' ? concise(string(object(update.content)?.text)) : undefined }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const category: TraceCategory = update.kind === 'search' ? 'web-search' : update.kind === 'execute' ? 'command' : update.kind === 'edit' ? 'file-change' : 'tool'
    return { category, title: 'Kimi 工具调用', phase: update.status === 'completed' ? '完成' : update.status === 'failed' ? '失败' : '执行中', severity: update.status === 'completed' ? 'success' : update.status === 'failed' ? 'error' : 'neutral', eventType, summary: concise(string(update.title)) }
  }
  if (update.sessionUpdate === 'plan') return { category: 'tool', title: '更新执行计划', severity: 'neutral', eventType }
  return { category: 'session', title: 'Kimi 会话状态', severity: 'neutral', eventType }
}

function pi(payload: JsonObject): Description {
  const type = string(payload.type)
  const base = { eventType: type, severity: 'neutral' as const }
  if (type === 'session') return { ...base, category: 'session', title: 'Pi 会话', summary: string(payload.id) }
  if (type.startsWith('tool_execution_')) return { ...base, ...toolDescription(string(payload.toolName), object(payload.args)),
    phase: type.endsWith('_end') ? payload.isError ? '失败' : '完成' : type.endsWith('_start') ? '开始' : '进行中',
    severity: payload.isError ? 'error' : type.endsWith('_end') ? 'success' : 'neutral' }
  if (type.startsWith('message_')) {
    const message = object(payload.message)
    if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return { ...base, category: 'diagnostic', title: 'Pi 请求失败', severity: 'error', summary: string(message.errorMessage) }
    const delta = object(payload.assistantMessageEvent)
    const thinking = string(delta?.type).startsWith('thinking_')
    return { ...base, category: thinking ? 'reasoning' : 'message', title: thinking ? '思考过程' : message?.role === 'toolResult' ? '工具消息' : message?.role === 'user' ? '用户输入' : 'Agent 回复',
      phase: type === 'message_end' ? '完成' : '进行中', summary: detail(delta?.delta) }
  }
  if (['agent_start', 'agent_end', 'turn_start', 'turn_end'].includes(type)) return { ...base, category: 'turn', title: 'Pi 执行轮次', phase: type.endsWith('_end') ? '结束' : '开始' }
  return unknown(payload)
}

function classify(text: string, kind: RuntimeEvent['kind'], adapter: Adapter, stream: Stream): Description | undefined {
  const parsed = parse(text)
  if (!parsed.valid) return undefined
  const payload = parsed.value
  if (!payload) return { ...fallback(kind), title: kind === 'stderr' ? '诊断输出' : '结构化输出' }
  if (kind === 'stderr') {
    const type = string(payload.type)
    if (type === 'error' || payload.level === 'error' || payload.level === 'fatal' || failed(payload)) return errorDescription(payload, type || string(payload.level))
    return { ...fallback(kind), eventType: type || undefined }
  }
  return adapter === 'codex' ? codex(payload) : adapter === 'claude' ? claude(payload, stream) : adapter === 'kimi' ? kimi(payload) : adapter === 'pi' ? pi(payload) : unknown(payload)
}
function lifecycle(event: RuntimeEvent): TraceEntry {
  const titles: Record<RuntimeEvent['kind'], string> = { started: '启动 Runtime', completed: '执行完成', failed: '执行失败', stopped: '停止执行', stdout: '标准输出', stderr: '诊断输出' }
  return { ...event, category: 'runtime', title: titles[event.kind], phase: event.kind === 'started' ? '开始' : event.kind === 'stopped' ? '已停止' : event.kind === 'completed' ? '完成' : '失败', severity: event.kind === 'failed' ? 'error' : event.kind === 'completed' ? 'success' : 'neutral', eventType: event.kind, sourceIds: [event.id] }
}

/** Read-only presentation of persisted raw events. Neither storage nor export is changed. */
export function getTraceEntries(task: Task, run?: Run): TraceEntry[] {
  const entries: TraceEntry[] = []
  const streams = new Map<string, Stream>()
  const members = new Map<string, RunMember>(task.runs.flatMap(entry => entry.members.map(member => [`${entry.id}:${member.id}`, member] as const)))
  const flush = (stream: Stream, malformed = false) => {
    if (stream.pending && !stream.pending.complete) {
      const { entry, index } = stream.pending
      entries[index] = { ...entry, ...fallback(entry.kind, false, malformed) }
    }
    stream.pending = undefined
  }
  for (const event of task.events) {
    if (run && event.runId !== run.id) continue
    const route = `${event.runId}:${event.memberId}`
    if (event.kind !== 'stdout' && event.kind !== 'stderr') {
      for (const channel of ['stdout', 'stderr']) {
        const stream = streams.get(`${route}:${channel}`)
        if (stream) flush(stream, true)
      }
      entries.push(lifecycle(event))
      continue
    }
    const key = `${route}:${event.kind}`
    let stream = streams.get(key)
    if (!stream) { stream = { blocks: new Map(), tools: new Map() }; streams.set(key, stream) }
    const adapter = members.get(route)?.runtime.adapter ?? 'generic'
    if (adapter === 'generic') {
      entries.push({ ...event, ...(classify(event.text, event.kind, adapter, stream) ?? fallback(event.kind)), sourceIds: [event.id] })
      continue
    }
    // Legacy traces sometimes use one complete JSON object per chunk without a
    // newline. A complete object followed by non-whitespace starts a new frame.
    if (stream.pending?.complete && event.text.trim() && !/^[\t ]*\r?\n/.test(event.text)) flush(stream)
    // A malformed abandoned frame must not swallow a later independently valid
    // object. A valid concatenation always wins, preserving genuine fragments.
    if (stream.pending && !stream.pending.complete && event.text.includes('\n') && parse(event.text).valid && !parse(stream.pending.entry.text + event.text).valid) flush(stream, true)
    let offset = 0
    while (offset < event.text.length) {
      const newline = event.text.indexOf('\n', offset)
      const end = newline < 0 ? event.text.length : newline + 1
      const piece = event.text.slice(offset, end)
      const previous = stream.pending
      const entry: TraceEntry = previous ? {
        ...previous.entry, text: previous.entry.text + piece,
        sourceIds: previous.entry.sourceIds.includes(event.id) ? [...previous.entry.sourceIds] : [...previous.entry.sourceIds, event.id],
      } : { ...event, id: `trace:${event.id}:${offset}`, text: piece, ...fallback(event.kind), sourceIds: [event.id] }
      const description = classify(entry.text, event.kind, adapter, stream)
      const possibleFragment = !description && /^[{[]/.test(entry.text.trimStart()) && newline < 0 && entry.text.length <= MAX_PENDING
      Object.assign(entry, { phase: undefined, eventType: undefined, summary: undefined }, description ?? fallback(event.kind, possibleFragment, !possibleFragment && /^[{[]/.test(entry.text.trimStart())))
      const index = previous?.index ?? entries.length
      entries[index] = entry
      stream.pending = description || possibleFragment ? { entry, index, complete: Boolean(description) } : undefined
      if (newline >= 0) flush(stream, true)
      offset = end
    }
    if (!event.text) entries.push({ ...event, ...fallback(event.kind), sourceIds: [event.id] })
  }
  for (const [key, stream] of streams) {
    const route = key.slice(0, key.lastIndexOf(':'))
    // Recovered interrupted runs have no terminal event; their partial bytes are
    // still preserved, but must not be presented as actively arriving forever.
    if (members.get(route)?.status !== 'running') flush(stream, true)
  }
  return entries
}
