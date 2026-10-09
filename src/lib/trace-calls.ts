import { getTraceEntries, type TraceCategory, type TraceEntry } from './trace-events'
import type { Run, RunMember, RuntimeEvent, Task } from './types'

type JsonObject = Record<string, unknown>
export interface TraceToolCall {
  id: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'incomplete'
  startedAt?: string
  endedAt?: string
  input?: unknown
  output?: unknown
  inputNote?: string
  outputNote?: string
  records: TraceEntry[]
}
export interface TraceMessageStream {
  text: string
  status: 'running' | 'received' | 'completed' | 'stopped' | 'incomplete'
  records: TraceEntry[]
}
export interface TraceReasoningStream extends TraceMessageStream { estimatedTokens?: number }
export type TraceDisplayEntry = TraceEntry & { call?: TraceToolCall; message?: TraceMessageStream; reasoning?: TraceReasoningStream }
type CallEntry = TraceEntry & { call: TraceToolCall }
type MessageEntry = TraceDisplayEntry & { message: TraceMessageStream }
type ReasoningEntry = TraceDisplayEntry & { reasoning: TraceReasoningStream }
interface StreamBlock { key: string; name: string; partial: string; kind: 'input' | 'result' | 'message' | 'reasoning'; message?: MessageEntry; reasoning?: ReasoningEntry }
interface ClaudeStream {
  blocks: Map<number, StreamBlock>
  content: Set<MessageEntry | ReasoningEntry>
  messageId?: string
  epoch?: string
  startRecord?: TraceEntry
  activeReasoning?: ReasoningEntry
}
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const string = (value: unknown) => typeof value === 'string' ? value : ''
const compact = (value: string) => value.replace(/[\r\n\t\u0000-\u001f]+/g, ' ').trim().slice(0, 160) || undefined
const routeFor = (runId: string, memberId: string) => JSON.stringify([runId, memberId])
const toolCategories = new Set<TraceCategory>(['web-search', 'command', 'file-change', 'tool'])
// Server tools return these explicit block types, paired through tool_use_id:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
const claudeResultTypes = new Set(['tool_result', 'web_search_tool_result', 'web_fetch_tool_result'])
function parse(text: string): JsonObject | undefined {
  try { return object(JSON.parse(text)) } catch { return undefined }
}
function select(value: JsonObject, keys: string[]): JsonObject | undefined {
  const result = Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  return Object.keys(result).length ? result : undefined
}
function failed(value: JsonObject) {
  return value.is_error === true || ['failed', 'error', 'errored'].includes(string(value.status))
    || typeof value.exit_code === 'number' && value.exit_code !== 0
    || typeof value.exitCode === 'number' && value.exitCode !== 0
}
function mergeInput(previous: unknown, next: unknown): unknown {
  return object(previous) && object(next) ? { ...object(previous), ...object(next) } : next
}
function codexInput(item: JsonObject): unknown {
  if (item.type === 'web_search') {
    const action = object(item.action)
    const input = {
      ...(string(item.query) ? { query: item.query } : {}),
      ...(action && action.type !== 'other' ? { action } : {}),
    }
    return Object.keys(input).length ? input : undefined
  }
  if (item.type === 'command_execution') return select(item, ['command', 'cwd'])
  if (item.type === 'file_change') return select(item, ['changes'])
  if (item.type === 'todo_list') return select(item, ['items'])
  if (item.arguments !== undefined) return item.arguments
  if (item.input !== undefined) return item.input
  return select(item, ['prompt', 'receiver_thread_ids'])
}
function codexOutput(item: JsonObject, terminal: boolean): unknown {
  const output = select(item, ['aggregated_output', 'stdout', 'stderr', 'output', 'result', 'results', 'error', 'exit_code', 'exitCode', 'agents_states'])
  if (output) return output
  if (terminal && item.type === 'file_change') return select(item, ['changes'])
  return undefined
}
function describeTool(name: string, input?: unknown): Pick<TraceEntry, 'category' | 'title' | 'summary'> {
  const params = object(input)
  if (/^(WebSearch|WebFetch|web_search|web_fetch)$/.test(name)) return { category: 'web-search', title: /fetch/i.test(name) ? '读取网页' : '网页搜索', summary: compact(string(params?.query || params?.url) || name) }
  if (/^(Bash|bash|shell|execute_command)$/.test(name)) return { category: 'command', title: '执行命令', summary: compact(string(params?.command) || name) }
  if (/^(Write|Edit|write|edit|MultiEdit|NotebookEdit)$/.test(name)) return { category: 'file-change', title: '文件变更', summary: compact([name, string(params?.path || params?.file_path || params?.notebook_path)].filter(Boolean).join(' · ')) }
  return { category: 'tool', title: '调用工具', summary: compact(name) }
}
function updateState(entry: CallEntry) {
  const labels: Record<TraceToolCall['status'], string> = { running: '执行中', completed: '完成', failed: '失败', stopped: '已停止', incomplete: '未完成' }
  entry.phase = labels[entry.call.status]
  entry.severity = entry.call.status === 'failed' ? 'error' : entry.call.status === 'completed' ? 'success' : 'neutral'
}

interface DisplayCache {
  count: number
  routes: string
  entries: TraceDisplayEntry[]
  byRun: Map<string, TraceDisplayEntry[]>
}
// App state replaces event arrays on append. Weak keys let abandoned histories
// and their derived records be collected; title/selection edits reuse the work.
const displayCache = new WeakMap<RuntimeEvent[], DisplayCache>()

/** Read-only projection shared by artifacts and the inspector, including run views. */
export function getTraceDisplayEntries(task: Task, run?: Run): TraceDisplayEntry[] {
  const routes = JSON.stringify(task.runs.map(run => [run.id, run.members.map(member => [member.id, member.runtime.adapter, member.status])]))
  let cached = displayCache.get(task.events)
  if (!cached || cached.count !== task.events.length || cached.routes !== routes) {
    cached = { count: task.events.length, routes, entries: buildTraceDisplayEntries(task), byRun: new Map() }
    displayCache.set(task.events, cached)
  }
  if (!run) return cached.entries
  let entries = cached.byRun.get(run.id)
  if (!entries) {
    entries = cached.entries.filter(entry => entry.runId === run.id)
    cached.byRun.set(run.id, entries)
  }
  return entries
}

/** Groups tool calls and streamed text/reasoning without changing the raw trace. */
function buildTraceDisplayEntries(task: Task): TraceDisplayEntry[] {
  const entries = getTraceEntries(task)
  const display: TraceDisplayEntry[] = []
  const calls = new Map<string, CallEntry>()
  const callRecords = new Map<CallEntry, { records: Set<string>; sources: Set<string> }>()
  const streams = new Map<string, ClaudeStream>()
  const members = new Map<string, RunMember>(task.runs.flatMap(item => item.members.map(member => [routeFor(item.id, member.id), member] as const)))
  const messages = new Map<string, TraceDisplayEntry & { message: TraceMessageStream }>()
  const claudeMessages = new Map<string, MessageEntry>()
  const piEpochs = new Map<string, string>()
  const messageParts = new Map<TraceMessageStream, { chunks: string[]; sources: Set<string> }>()
  const reasoningStreams = new Map<string, ReasoningEntry>()
  const reasoningRecords = new Map<ReasoningEntry, { records: Set<string>; sources: Set<string> }>()
  const finishMessage = (route: string, status: TraceMessageStream['status']) => {
    const entry = messages.get(route)
    if (!entry) return
    entry.message.status = status
    entry.phase = { running: '进行中', received: '已接收', completed: '完成', stopped: '已停止', incomplete: '未完成' }[status]
    entry.severity = status === 'completed' ? 'success' : 'neutral'
    messages.delete(route)
  }
  const appendMessageRecord = (entry: MessageEntry, record: TraceEntry, text = '', authoritative = false) => {
    const parts = messageParts.get(entry.message)!
    if (!entry.message.records.some(item => item.id === record.id)) entry.message.records.push(record)
    for (const id of record.sourceIds) parts.sources.add(id)
    if (authoritative) parts.chunks = [text]
    else if (text) parts.chunks.push(text)
    entry.eventType = record.eventType
  }
  const finishClaudeMessage = (entry: MessageEntry, status: TraceMessageStream['status']) => {
    entry.message.status = status
    entry.phase = { running: '进行中', received: '已接收', completed: '完成', stopped: '已停止', incomplete: '未完成' }[status]
    entry.severity = status === 'completed' ? 'success' : 'neutral'
  }
  const finishClaudeMessagesForRoute = (route: string, status: string) => {
    for (const entry of claudeMessages.values()) {
      if (routeFor(entry.runId, entry.memberId) !== route || entry.message.status !== 'running') continue
      finishClaudeMessage(entry, status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'incomplete')
    }
  }
  const register = (key: string, id: string, record: TraceEntry, presentation = record) => {
    let entry = calls.get(key)
    if (!entry) {
      entry = { ...presentation, sourceIds: [], call: { id, status: 'running', records: [] } }
      calls.set(key, entry)
      callRecords.set(entry, { records: new Set(), sources: new Set() })
      display.push(entry)
    }
    // A single Claude frame can contain several blocks for the same call.
    const seen = callRecords.get(entry)!
    if (!seen.records.has(record.id)) { seen.records.add(record.id); entry.call.records.push(record) }
    for (const id of record.sourceIds) if (!seen.sources.has(id)) { seen.sources.add(id); entry.sourceIds.push(id) }
    entry.eventType = record.eventType
    return entry
  }
  const appendReasoningRecord = (entry: ReasoningEntry, record: TraceEntry) => {
    const seen = reasoningRecords.get(entry)!
    if (!seen.records.has(record.id)) { seen.records.add(record.id); entry.reasoning.records.push(record) }
    for (const id of record.sourceIds) if (!seen.sources.has(id)) { seen.sources.add(id); entry.sourceIds.push(id) }
    entry.eventType = record.eventType
  }
  const finishReasoning = (entry: ReasoningEntry, status: TraceReasoningStream['status']) => {
    entry.reasoning.status = status
    entry.phase = { running: '进行中', received: '已接收', completed: '完成', stopped: '已停止', incomplete: '未完成' }[status]
    entry.severity = status === 'completed' ? 'success' : 'neutral'
  }
  const finishReasoningForRoute = (route: string, status: string) => {
    for (const entry of reasoningStreams.values()) {
      if (routeFor(entry.runId, entry.memberId) !== route || entry.reasoning.status !== 'running') continue
      finishReasoning(entry, status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'incomplete')
    }
  }
  const finish = (route: string, status: string, timestamp?: string, scope?: string) => {
    for (const [key, entry] of calls) {
      if (routeFor(entry.runId, entry.memberId) !== route || entry.call.status !== 'running') continue
      if (scope && JSON.parse(key)[0] !== scope) continue
      entry.call.status = status === 'stopped' ? 'stopped' : 'incomplete'
      if (status === 'stopped') entry.call.endedAt = timestamp
      entry.call.outputNote = status === 'stopped' ? '执行已停止，未收到工具的最终结果。' : status === 'failed' ? '本次执行失败，未收到此工具的最终结果。' : '本次执行已结束，未收到工具的最终结果。'
      updateState(entry)
    }
  }
  for (const record of entries) {
    const route = routeFor(record.runId, record.memberId)
    const adapter = members.get(route)?.runtime.adapter
    const payload = record.kind === 'stdout' ? parse(record.text) : undefined
    if (adapter === 'kimi') {
      const update = payload?.type === 'kimi.acp.update' ? object(payload.update) : undefined
      const content = object(update?.content)
      if (update?.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
        let entry = messages.get(route)
        if (!entry) {
          entry = { ...record, sourceIds: [], message: { text: '', status: 'running', records: [] } }
          messages.set(route, entry)
          messageParts.set(entry.message, { chunks: [], sources: new Set() })
          display.push(entry)
        }
        const parts = messageParts.get(entry.message)!
        parts.chunks.push(content.text)
        for (const id of record.sourceIds) parts.sources.add(id)
        entry.message.records.push(record)
        continue
      }
      if (record.kind === 'completed' || record.kind === 'stopped' || record.kind === 'failed') {
        finishMessage(route, record.kind === 'failed' ? 'incomplete' : record.kind)
      } else if (payload?.type === 'kimi.prompt_completed') {
        finishMessage(route, payload.stopReason === 'end_turn' ? 'completed' : 'incomplete')
      } else if (payload || record.kind !== 'stdout') {
        finishMessage(route, 'received')
      }
      // An unfinished JSON transport frame must not end the preceding text stream.
    }
    if (record.kind === 'completed' || record.kind === 'failed' || record.kind === 'stopped') {
      finish(route, record.kind, record.timestamp)
      finishClaudeMessagesForRoute(route, record.kind)
      finishReasoningForRoute(route, record.kind)
    }
    if (!payload || adapter === 'generic') { display.push(record); continue }

    if (adapter === 'pi') {
      const message = object(payload.message)
      if (payload.type === 'message_start' && message?.role === 'assistant') {
        piEpochs.set(route, record.id)
        continue
      }
      const delta = object(payload.assistantMessageEvent)
      const appendPiBlock = (index: number, kind: string, text: string, authoritative: boolean) => {
        if (kind !== 'text' && kind !== 'thinking') return
        if (!piEpochs.has(route)) piEpochs.set(route, record.id)
        const key = JSON.stringify([route, 'pi', piEpochs.get(route), index])
        if (kind === 'text') {
          let entry = claudeMessages.get(key)
          if (!entry) {
            entry = { ...record, id: `${record.id}:pi:${index}`, category: 'message', title: 'Agent 回复', sourceIds: [], message: { text: '', status: 'running', records: [] } }
            claudeMessages.set(key, entry)
            messageParts.set(entry.message, { chunks: [], sources: new Set() })
            display.push(entry)
          }
          appendMessageRecord(entry, record, text, authoritative)
          if (authoritative) finishClaudeMessage(entry, ['error', 'aborted', 'length'].includes(string(message?.stopReason)) ? 'incomplete' : 'completed')
        } else {
          let entry = reasoningStreams.get(key)
          if (!entry) {
            entry = { ...record, id: `${record.id}:pi:${index}`, category: 'reasoning', title: '思考过程', sourceIds: [], reasoning: { text: '', status: 'running', records: [] } }
            reasoningStreams.set(key, entry)
            reasoningRecords.set(entry, { records: new Set(), sources: new Set() })
            display.push(entry)
          }
          appendReasoningRecord(entry, record)
          entry.reasoning.text = authoritative ? text : entry.reasoning.text + text
          if (authoritative) finishReasoning(entry, 'completed')
        }
      }
      if (payload.type === 'message_update' && delta && Number.isInteger(delta.contentIndex)
        && ['text_delta', 'thinking_delta'].includes(string(delta.type))) {
        appendPiBlock(delta.contentIndex as number, delta.type === 'text_delta' ? 'text' : 'thinking', string(delta.delta), false)
        continue
      }
      if (payload.type === 'message_end' && message?.role === 'assistant') {
        if (Array.isArray(message.content)) message.content.forEach((value, index) => {
          const block = object(value)
          if (block) appendPiBlock(index, string(block.type), string(block.type === 'thinking' ? block.thinking : block.text), true)
        })
        piEpochs.delete(route)
        if (!['error', 'aborted'].includes(string(message.stopReason))) continue
      }
    }

    if (adapter === 'pi' && string(payload.type).startsWith('tool_execution_')) {
      const id = string(payload.toolCallId)
      if (id) {
        const entry = register(JSON.stringify([route, 'pi', id]), id, record)
        Object.assign(entry, describeTool(string(payload.toolName), payload.args ?? entry.call.input))
        if (payload.type === 'tool_execution_start') entry.call.startedAt ??= record.timestamp
        if (payload.args !== undefined) entry.call.input = payload.args
        if (payload.partialResult !== undefined && entry.call.status === 'running') entry.call.output = payload.partialResult
        if (payload.type === 'tool_execution_end') {
          entry.call.output = payload.result
          entry.call.status = payload.isError ? 'failed' : 'completed'
          entry.call.endedAt = record.timestamp
          entry.call.outputNote = undefined
        }
        updateState(entry)
        continue
      }
    }

    if (adapter === 'codex') {
      const type = string(payload.type)
      if (type === 'turn.completed' || type === 'turn.failed') finish(route, type.endsWith('failed') ? 'failed' : 'completed')
      const item = object(payload.item)
      const id = string(item?.id)
      if (!item || !id || !toolCategories.has(record.category) || !['item.started', 'item.updated', 'item.completed', 'item.failed'].includes(type)) { display.push(record); continue }
      const entry = register(JSON.stringify([route, 'codex', id]), id, record)
      const call = entry.call
      if (type === 'item.started' && !call.startedAt && call.status === 'running') call.startedAt = record.timestamp
      if (record.summary) entry.summary = record.summary
      const input = codexInput(item)
      if (input !== undefined) call.input = mergeInput(call.input, input)
      const terminal = type === 'item.completed' || type === 'item.failed' || failed(item)
      const output = codexOutput(item, terminal)
      if (output !== undefined) call.output = mergeInput(call.output, output)
      if (terminal) {
        call.status = failed(item) || type === 'item.failed' ? 'failed' : 'completed'
        call.endedAt = record.timestamp
        call.outputNote = undefined
      }
      updateState(entry)
      continue
    }

    if (adapter === 'kimi' && payload.type === 'kimi.acp.update') {
      const update = object(payload.update)
      const id = string(update?.toolCallId)
      if (update && id && ['tool_call', 'tool_call_update'].includes(string(update.sessionUpdate))) {
        const entry = register(JSON.stringify([route, 'kimi', id]), id, record)
        if (update.sessionUpdate === 'tool_call' && !entry.call.startedAt) entry.call.startedAt = record.timestamp
        if (record.summary) entry.summary = record.summary
        if (update.kind) entry.category = record.category
        if (update.rawInput !== undefined) entry.call.input = mergeInput(entry.call.input, update.rawInput)
        if (update.rawOutput !== undefined) entry.call.output = update.rawOutput
        else if (Array.isArray(update.content) && update.content.length) entry.call.output = update.content
        if (update.status === 'completed' || update.status === 'failed') {
          entry.call.status = update.status
          entry.call.endedAt = record.timestamp
          entry.call.outputNote = undefined
        }
        updateState(entry)
        continue
      }
    }

    if (adapter === 'claude') {
      const type = string(payload.type)
      const scope = JSON.stringify([route, string(payload.parent_tool_use_id)])
      const keyFor = (id: string) => JSON.stringify([scope, 'claude', id])
      let stream = streams.get(scope)
      if (!stream) { stream = { blocks: new Map(), content: new Set() }; streams.set(scope, stream) }
      const toolUse = (block: JsonObject, presentation: TraceEntry) => {
        const id = string(block.id)
        if (!id) return undefined
        const entry = register(keyFor(id), id, record, presentation)
        // A delayed full assistant duplicate can follow an orphan result. Its
        // receipt time is not evidence of the original tool execution start.
        if (!entry.call.startedAt && entry.call.status === 'running') entry.call.startedAt = record.timestamp
        if (block.input !== undefined) { entry.call.input = mergeInput(entry.call.input, block.input); entry.call.inputNote = undefined }
        Object.assign(entry, describeTool(string(block.name), entry.call.input))
        updateState(entry)
        return entry
      }
      const toolResult = (block: JsonObject, presentation: TraceEntry) => {
        const id = string(block.tool_use_id)
        if (!id) return undefined
        const resultType = string(block.type)
        const serverTool = resultType === 'web_search_tool_result' ? 'web_search' : resultType === 'web_fetch_tool_result' ? 'web_fetch' : undefined
        const entry = register(keyFor(id), id, record, serverTool ? { ...presentation, ...describeTool(serverTool) } : presentation)
        const serverError = serverTool && object(block.content)?.type === `${resultType}_error`
        entry.call.status = failed(block) || serverError ? 'failed' : 'completed'
        entry.call.endedAt = record.timestamp
        entry.call.outputNote = undefined
        if (block.content !== undefined) entry.call.output = block.content
        else if (block.output !== undefined) entry.call.output = block.output
        updateState(entry)
        return entry
      }
      const reasoningKey = (index: number, messageId = stream.messageId) => JSON.stringify([scope, 'claude-thinking', messageId || record.id, index])
      const messageKey = (index: number, messageId = stream.messageId) => JSON.stringify([scope, 'claude-text', messageId || stream.epoch || record.id, index])
      const message = (index: number, messageId = stream.messageId, presentation: TraceEntry = record) => {
        const key = messageKey(index, messageId)
        let entry = claudeMessages.get(key)
        if (!entry) {
          entry = { ...presentation, category: 'message', title: '生成回复', phase: '进行中', severity: 'neutral', summary: undefined, sourceIds: [], message: { text: '', status: 'running', records: [] } }
          claudeMessages.set(key, entry)
          messageParts.set(entry.message, { chunks: [], sources: new Set() })
          if (stream.startRecord) appendMessageRecord(entry, stream.startRecord)
          stream.content.add(entry)
          display.push(entry)
        }
        return { entry, key }
      }
      const reasoning = (index: number, initial = '', messageId = stream.messageId) => {
        const key = reasoningKey(index, messageId)
        let entry = reasoningStreams.get(key)
        if (!entry) {
          entry = { ...record, category: 'reasoning', title: '思考过程', phase: '进行中', severity: 'neutral', summary: undefined, sourceIds: [], reasoning: { text: '', status: 'running', records: [] } }
          reasoningStreams.set(key, entry)
          reasoningRecords.set(entry, { records: new Set(), sources: new Set() })
          if (stream.startRecord) appendReasoningRecord(entry, stream.startRecord)
          stream.content.add(entry)
          display.push(entry)
        }
        appendReasoningRecord(entry, record)
        if (initial) entry.reasoning.text = initial
        entry.summary = compact(entry.reasoning.text)
        return entry
      }
      if (type === 'system' && payload.subtype === 'thinking_tokens' && stream.activeReasoning) {
        const entry = stream.activeReasoning
        appendReasoningRecord(entry, record)
        if (typeof payload.estimated_tokens === 'number') entry.reasoning.estimatedTokens = payload.estimated_tokens
        continue
      }
      if (type === 'stream_event') {
        const event = object(payload.event)
        const nested = string(event?.type)
        if (nested === 'message_start') {
          if (stream.startRecord && !stream.content.size) display.push(stream.startRecord)
          stream.blocks.clear()
          stream.content.clear()
          stream.messageId = string(object(event?.message)?.id) || record.id
          stream.epoch = stream.messageId
          stream.startRecord = record
          stream.activeReasoning = undefined
          continue
        }
        if (nested === 'message_stop') {
          const grouped = stream.content.size > 0
          for (const entry of stream.content) {
            if (entry.message) {
              appendMessageRecord(entry as MessageEntry, record)
              finishClaudeMessage(entry as MessageEntry, 'completed')
            } else if (entry.reasoning) {
              appendReasoningRecord(entry as ReasoningEntry, record)
              finishReasoning(entry as ReasoningEntry, 'completed')
            }
          }
          if (!grouped && stream.startRecord) display.push(stream.startRecord)
          stream.blocks.clear()
          stream.content.clear()
          stream.messageId = undefined
          stream.epoch = undefined
          stream.startRecord = undefined
          stream.activeReasoning = undefined
          if (grouped) continue
        }
        if (nested === 'content_block_start' && event) {
          const block = object(event.content_block)
          if (block?.type === 'thinking' && typeof event.index === 'number') {
            const entry = reasoning(event.index, string(block.thinking))
            stream.blocks.set(event.index, { key: '', name: '', partial: '', kind: 'reasoning', reasoning: entry })
            stream.activeReasoning = entry
            continue
          }
          if (block?.type === 'text' && typeof event.index === 'number') {
            stream.epoch ??= stream.messageId || record.id
            const current = message(event.index)
            appendMessageRecord(current.entry, record, string(block.text))
            stream.blocks.set(event.index, { key: current.key, name: '', partial: '', kind: 'message', message: current.entry })
            continue
          }
          if (block && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
            const entry = toolUse(block, record)
            if (entry) {
              if (typeof event.index === 'number') stream.blocks.set(event.index, { key: keyFor(entry.call.id), name: string(block.name), partial: '', kind: 'input' })
              continue
            }
          }
          if (block && claudeResultTypes.has(string(block.type))) {
            const entry = toolResult(block, record)
            if (entry) {
              if (typeof event.index === 'number') stream.blocks.set(event.index, { key: keyFor(entry.call.id), name: '', partial: '', kind: 'result' })
              continue
            }
          }
          // An index can be reused by a new non-tool block even in incomplete logs.
          if (typeof event.index === 'number') stream.blocks.delete(event.index)
        }
        if ((nested === 'content_block_delta' || nested === 'content_block_stop') && event && typeof event.index === 'number') {
          let block = stream.blocks.get(event.index)
          const delta = object(event.delta)
          if (!block && nested === 'content_block_delta' && delta?.type === 'text_delta') {
            stream.epoch ??= stream.messageId || record.id
            const current = message(event.index)
            block = { key: current.key, name: '', partial: '', kind: 'message', message: current.entry }
            stream.blocks.set(event.index, block)
          }
          if (block?.kind === 'message' && block.message) {
            appendMessageRecord(block.message, record, nested === 'content_block_delta' && delta?.type === 'text_delta' ? string(delta.text) : '')
            if (nested === 'content_block_stop') {
              finishClaudeMessage(block.message, 'completed')
              stream.blocks.delete(event.index)
            }
            continue
          }
          if (block?.kind === 'reasoning' && block.reasoning) {
            const entry = block.reasoning
            appendReasoningRecord(entry, record)
            if (nested === 'content_block_delta' && delta?.type === 'thinking_delta') entry.reasoning.text += string(delta.thinking)
            entry.summary = compact(entry.reasoning.text)
            if (nested === 'content_block_stop') {
              finishReasoning(entry, 'completed')
              stream.blocks.delete(event.index)
              if (stream.activeReasoning === entry) stream.activeReasoning = undefined
            }
            continue
          }
          const entry = block ? calls.get(block.key) : undefined
          if (block && entry && (nested === 'content_block_stop' || block.kind === 'input' && delta?.type === 'input_json_delta')) {
            register(block.key, entry.call.id, record)
            if (delta?.type === 'input_json_delta') {
              block.partial += string(delta.partial_json)
              try { entry.call.input = JSON.parse(block.partial); entry.call.inputNote = undefined }
              catch { entry.call.input = block.partial; entry.call.inputNote = '工具参数尚未完整接收，显示已收到的原文。' }
              Object.assign(entry, describeTool(block.name, entry.call.input))
            }
            // This closes the argument block, not the tool's execution.
            if (nested === 'content_block_stop') stream.blocks.delete(event.index)
            updateState(entry)
            continue
          }
        }
      }
      if (type === 'assistant' || type === 'user') {
        const content = object(payload.message)?.content
        const blocks = Array.isArray(content) ? content.map(object) : []
        const fullMessageId = string(object(payload.message)?.id)
        if (type === 'assistant') blocks.forEach((block, index) => {
          if (block?.type === 'thinking') {
            const entry = reasoning(index, string(block.thinking), fullMessageId)
            finishReasoning(entry, 'completed')
          } else if (block?.type === 'text') {
            const presentation = { ...record, id: `${record.id}:message:${index}` }
            const current = message(index, fullMessageId, presentation)
            appendMessageRecord(current.entry, record, string(block.text), true)
            finishClaudeMessage(current.entry, 'completed')
          }
        })
        const toolBlocks = blocks.filter((block): block is JsonObject => Boolean(block && (['tool_use', 'server_tool_use'].includes(string(block.type)) || claudeResultTypes.has(string(block.type)))))
        if (toolBlocks.length) {
          let retained = false
          for (const [index, block] of toolBlocks.entries()) {
            const presentation = toolBlocks.length > 1 ? { ...record, id: `${record.id}:tool:${index}` } : record
            const entry = claudeResultTypes.has(string(block.type)) ? toolResult(block, presentation) : toolUse(block, presentation)
            if (!entry && !retained) { display.push(record); retained = true }
          }
          continue
        }
        if (type === 'assistant' && blocks.some(block => block?.type === 'text' || block?.type === 'thinking')) continue
      }
      if (type === 'result') finish(route, failed(payload) || string(payload.subtype).startsWith('error') ? 'failed' : 'completed', undefined, scope)
    }
    display.push(record)
  }
  for (const [route, member] of members) if (member.status !== 'running') finish(route, member.status)
  for (const [route, member] of members) if (member.status !== 'running') finishClaudeMessagesForRoute(route, member.status)
  for (const [route, member] of members) if (member.status !== 'running') finishReasoningForRoute(route, member.status)
  for (const entry of calls.values()) {
    const call = entry.call
    if (!members.has(routeFor(entry.runId, entry.memberId)) && call.status === 'running') finish(routeFor(entry.runId, entry.memberId), 'interrupted')
    if (call.input === undefined) call.inputNote = '运行时未提供此工具的入参。'
    if (call.output === undefined && !call.outputNote && call.status !== 'running') {
      call.outputNote = entry.category === 'web-search' && call.status === 'completed'
        ? '运行时已报告搜索完成，但未提供搜索结果正文。'
        : '运行时未提供此工具的出参。'
    }
  }
  for (const [route] of messages) {
    const status = members.get(route)?.status
    if (status !== 'running') finishMessage(route, status === 'completed' || status === 'stopped' ? status : 'incomplete')
  }
  for (const entry of display) {
    if (!entry.message) continue
    const parts = messageParts.get(entry.message)!
    entry.message.text = parts.chunks.join('')
    entry.sourceIds = [...parts.sources]
    entry.summary = compact(entry.message.text)
  }
  return display
}
