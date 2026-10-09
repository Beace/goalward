import type { Run, RunMember, RunStatus, RuntimeEvent, Task } from './types'

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const string = (value: unknown) => typeof value === 'string' ? value : ''
const comparable = (text: string) => text.trim().replace(/\r\n/g, '\n')
const summary = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160)

export interface PublicOutput { key: string; text: string; createdAt: string; streaming: boolean; kind: 'message' | 'reasoning' }
export interface RunActivity {
  phase: 'starting' | 'waiting' | 'web-search' | 'tool' | 'responding' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  label: string
  summary?: string
  lastEventAt?: string
  memberId?: string
}
interface TextBlock { type: string; text: string }
interface Projection {
  sessionId?: string
  outputs: PublicOutput[]
  genericText: string
  genericAt?: string
  pending: string
  pendingAt?: string
  activeClaudeKey?: string
  claudeBlocks: Map<number, TextBlock>
  claudeSequence: number
  activity: RunActivity
}

// This cache is only an acceleration of the persisted trace. A cache miss replays
// raw events. Each appended trace gets its own projection; old immutable states
// never see future text, and unused traces can be collected with their cache.
const projections = new WeakMap<RuntimeEvent[], Map<string, Projection>>()
const route = (run: Run, member: RunMember) => `${run.id}:${member.id}`
const fresh = (): Projection => ({ outputs: [], genericText: '', pending: '', claudeBlocks: new Map(), claudeSequence: 0, activity: { phase: 'starting', label: '正在启动 Runtime' } })
const clone = (state: Projection): Projection => ({
  ...state, outputs: state.outputs.map(item => ({ ...item })),
  claudeBlocks: new Map([...state.claudeBlocks].map(([index, block]) => [index, { ...block }])), activity: { ...state.activity },
})
function upsert(state: Projection, key: string, text: string, createdAt: string, streaming: boolean, kind: PublicOutput['kind'] = 'message') {
  if (!text.trim()) return
  const previous = state.outputs.find(item => item.key === key)
  if (previous) { previous.text = text; previous.streaming = streaming }
  else state.outputs.push({ key, text, createdAt, streaming, kind })
}
function activity(state: Projection, phase: RunActivity['phase'], label: string, detail?: string) {
  state.activity = { ...state.activity, phase, label, summary: detail ? summary(detail) : undefined }
}
function completeOutputs(state: Projection) { state.outputs.forEach(item => { item.streaming = false }) }
function claudeText(state: Projection, timestamp: string, streaming: boolean) {
  if (!state.activeClaudeKey) return
  const text = [...state.claudeBlocks].sort(([left], [right]) => left - right)
    .filter(([, block]) => block.type === 'text').map(([, block]) => block.text).join('\n\n')
  upsert(state, state.activeClaudeKey, text, timestamp, streaming)
}
function claudeReasoning(state: Projection, index: number, timestamp: string, streaming: boolean) {
  if (!state.activeClaudeKey) return
  const block = state.claudeBlocks.get(index)
  if (block?.type !== 'thinking') return
  upsert(state, `${state.activeClaudeKey}:reasoning:${index}`, block.text, timestamp, streaming, 'reasoning')
}
function claudeTool(state: Projection, block: JsonObject) {
  const name = string(block.name)
  const web = /^(WebSearch|WebFetch|web_search|web_fetch)$/.test(name)
  activity(state, web ? 'web-search' : 'tool', web ? '正在检索网页' : '正在调用工具', name || undefined)
}

function readClaude(state: Projection, payload: JsonObject, timestamp: string) {
  if (payload.type === 'stream_event') {
    const event = object(payload.event)
    if (!event) return
    if (event.type === 'message_start') {
      const message = object(event.message)
      state.activeClaudeKey = `claude:${string(message?.id) || `stream-${++state.claudeSequence}`}`
      state.claudeBlocks.clear()
      activity(state, 'waiting', '等待 Runtime 输出')
    } else if (event.type === 'content_block_start' && Number.isInteger(event.index)) {
      const block = object(event.content_block)
      if (!block) return
      const type = string(block.type)
      state.claudeBlocks.set(event.index as number, { type, text: type === 'text' ? string(block.text) : type === 'thinking' ? string(block.thinking) : '' })
      if (type === 'text') { claudeText(state, timestamp, true); activity(state, 'responding', '正在生成回答') }
      else if (type === 'thinking') { claudeReasoning(state, event.index as number, timestamp, true); activity(state, 'waiting', '正在思考') }
      else if (type === 'tool_use' || type === 'server_tool_use') claudeTool(state, block)
    } else if (event.type === 'content_block_delta' && Number.isInteger(event.index)) {
      const delta = object(event.delta)
      const block = state.claudeBlocks.get(event.index as number)
      if (block?.type === 'text' && delta?.type === 'text_delta') {
        block.text += string(delta.text)
        claudeText(state, timestamp, true)
        activity(state, 'responding', '正在生成回答')
      } else if (block?.type === 'thinking' && delta?.type === 'thinking_delta') {
        block.text += string(delta.thinking)
        claudeReasoning(state, event.index as number, timestamp, true)
        activity(state, 'waiting', '正在思考')
      }
    } else if (event.type === 'content_block_stop' && Number.isInteger(event.index)) {
      claudeReasoning(state, event.index as number, timestamp, false)
    } else if (event.type === 'message_stop') {
      claudeText(state, timestamp, false)
      activity(state, 'waiting', '等待 Runtime 下一步')
    }
  } else if (payload.type === 'assistant') {
    const message = object(payload.message)
    const content = message?.content
    const blocks = Array.isArray(content) ? content.map(object).filter((part): part is JsonObject => Boolean(part)) : []
    const text = Array.isArray(content) ? blocks.filter(block => block.type === 'text').map(block => string(block.text)).filter(Boolean).join('\n\n') : string(content)
    const key = string(message?.id) ? `claude:${string(message?.id)}`
      : state.outputs.find(item => item.kind === 'message' && comparable(item.text) === comparable(text))?.key
        ?? `claude:${string(payload.uuid) || comparable(text)}`
    if (Array.isArray(content)) {
      let publicInserted = false
      blocks.forEach((block, index) => {
        if (block.type === 'thinking') upsert(state, `${key}:reasoning:${index}`, string(block.thinking), timestamp, false, 'reasoning')
        else if (block.type === 'text' && !publicInserted) { upsert(state, key, text, timestamp, false); publicInserted = true }
      })
    } else upsert(state, key, text, timestamp, false)
    const tool = blocks.find(block => block.type === 'tool_use' || block.type === 'server_tool_use')
    if (tool) claudeTool(state, tool)
    else if (text.trim()) activity(state, 'waiting', '已收到回答，等待 Runtime 下一步')
  } else if (payload.type === 'user') {
    const content = object(payload.message)?.content
    if (Array.isArray(content) && content.some(part => object(part)?.type === 'tool_result')) activity(state, 'waiting', '工具已返回，等待 Runtime 下一步')
  } else if (payload.type === 'result') {
    const text = string(payload.result)
    const normalized = comparable(text)
    const publicOutputs = state.outputs.filter(output => output.kind === 'message')
    const duplicate = publicOutputs.some(output => comparable(output.text) === normalized)
      || comparable(publicOutputs.map(output => output.text).join('\n\n')) === normalized
    if (!duplicate) {
      const partial = state.outputs.find(output => output.key === state.activeClaudeKey && output.streaming)
      const key = partial && text.startsWith(partial.text) ? partial.key : `result:${string(payload.uuid) || normalized}`
      upsert(state, key, text, timestamp, false)
    }
    completeOutputs(state)
    activity(state, 'waiting', payload.is_error ? 'Runtime 返回异常，等待进程结束' : '回答已完成，等待进程结束')
  }
}

function readCodex(state: Projection, payload: JsonObject, timestamp: string) {
  const type = string(payload.type)
  const item = object(payload.item)
  if (['item.started', 'item.updated', 'item.completed'].includes(type) && item) {
    const complete = type === 'item.completed'
    if (item.type === 'agent_message') {
      const text = string(item.text)
      // Codex exec currently emits completed paragraphs. item.updated is an
      // item snapshot in the public schema, never an invented token delta.
      upsert(state, `codex:${string(item.id) || comparable(text)}`, text, timestamp, !complete)
      activity(state, complete ? 'waiting' : 'responding', complete ? '已收到回答，等待 Runtime 下一步' : '正在生成回答')
    } else if (item.type === 'web_search') {
      const action = object(item.action)
      const query = string(item.query) || string(action?.query) || string(action?.url)
      activity(state, complete ? 'waiting' : 'web-search', complete ? '检索已完成，等待 Runtime 下一步' : '正在检索网页', query)
    } else if (['command_execution', 'mcp_tool_call', 'file_change', 'collab_tool_call'].includes(string(item.type))) {
      const detail = item.type === 'command_execution' ? '执行本机命令'
        : item.type === 'file_change' ? '更新工作区文件' : string(item.tool) || '调用工具'
      activity(state, complete ? 'waiting' : 'tool', complete ? '工具已返回，等待 Runtime 下一步' : '正在执行工具', detail)
    } else if (item.type === 'reasoning') {
      activity(state, 'waiting', '等待 Runtime 输出')
    }
  } else if (type === 'thread.started' || type === 'turn.started') {
    activity(state, 'waiting', '等待 Runtime 输出')
  } else if (type === 'turn.completed' || type === 'turn.failed' || type === 'error') {
    completeOutputs(state)
    activity(state, 'waiting', type === 'turn.completed' ? '回答已完成，等待进程结束' : 'Runtime 返回异常，等待进程结束')
  }
}

function readKimi(state: Projection, payload: JsonObject, timestamp: string) {
  if (payload.type === 'kimi.permission_requested') { activity(state, 'waiting', '等待工具权限确认', string(object(payload.toolCall)?.title)); return }
  if (payload.type === 'kimi.permission_resolved') { activity(state, 'waiting', '已提交权限选择，等待 Runtime'); return }
  if (payload.type === 'kimi.prompt_completed') { completeOutputs(state); activity(state, 'waiting', '回答已结束，等待 Runtime 退出'); return }
  if (payload.type !== 'kimi.acp.update') return
  const update = object(payload.update)
  if (!update) return
  if (update.sessionUpdate === 'agent_message_chunk') {
    const content = object(update.content)
    if (content?.type !== 'text') return
    if (!state.activeClaudeKey) state.activeClaudeKey = `kimi:${++state.claudeSequence}`
    const previous = state.outputs.find(output => output.key === state.activeClaudeKey)?.text ?? ''
    upsert(state, state.activeClaudeKey, previous + string(content.text), timestamp, true)
    activity(state, 'responding', '正在生成回答')
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    completeOutputs(state)
    state.activeClaudeKey = undefined
    const complete = update.status === 'completed' || update.status === 'failed'
    activity(state, complete ? 'waiting' : update.kind === 'search' ? 'web-search' : 'tool', complete ? '工具已返回，等待 Runtime 下一步' : '正在执行工具', string(update.title))
  } else if (update.sessionUpdate === 'plan') {
    activity(state, 'waiting', '正在更新执行计划')
  }
}

function readPi(state: Projection, payload: JsonObject, timestamp: string) {
  const type = string(payload.type)
  const message = object(payload.message)
  if (type === 'message_start' && message?.role === 'assistant') {
    state.activeClaudeKey = `pi:${++state.claudeSequence}`
    state.claudeBlocks.clear()
    activity(state, 'waiting', '等待 Pi 输出')
  } else if (type === 'message_update') {
    const delta = object(payload.assistantMessageEvent)
    if (!delta || !Number.isInteger(delta.contentIndex)) return
    const index = delta.contentIndex as number
    const kind = string(delta.type)
    if (!state.activeClaudeKey) state.activeClaudeKey = `pi:${++state.claudeSequence}`
    if (kind === 'text_delta' || kind === 'thinking_delta') {
      const blockType = kind === 'text_delta' ? 'text' : 'thinking'
      const block = state.claudeBlocks.get(index)
      state.claudeBlocks.set(index, { type: blockType, text: (block?.text ?? '') + string(delta.delta) })
      const text = state.claudeBlocks.get(index)!.text
      upsert(state, `${state.activeClaudeKey}:${index}`, text, timestamp, true, blockType === 'thinking' ? 'reasoning' : 'message')
      activity(state, blockType === 'thinking' ? 'waiting' : 'responding', blockType === 'thinking' ? '正在思考' : '正在生成回答')
    }
  } else if (type === 'message_end' && message?.role === 'assistant') {
    if (!state.activeClaudeKey) state.activeClaudeKey = `pi:${++state.claudeSequence}`
    // Final content is authoritative; do not duplicate streamed text or expose tool results.
    const prefix = state.activeClaudeKey + ':'
    const blocks = Array.isArray(message.content) ? message.content.map(object) : []
    const keys = new Set<string>()
    blocks.forEach((block, index) => {
      if (block?.type !== 'text' && block?.type !== 'thinking') return
      if (!string(block.type === 'text' ? block.text : block.thinking).trim()) return
      const key = prefix + index
      keys.add(key)
      upsert(state, key, string(block.type === 'text' ? block.text : block.thinking), timestamp, false, block.type === 'thinking' ? 'reasoning' : 'message')
    })
    state.outputs = state.outputs.filter(output => !output.key.startsWith(prefix) || keys.has(output.key))
    state.activeClaudeKey = undefined
    state.claudeBlocks.clear()
    activity(state, 'waiting', message.stopReason === 'error' ? 'Pi 请求失败，等待进程结束' : '已收到回答，等待 Pi 下一步')
  } else if (type.startsWith('tool_execution_')) {
    const ended = type === 'tool_execution_end'
    activity(state, ended ? 'waiting' : 'tool', ended ? '工具已返回，等待 Pi 下一步' : '正在执行工具', string(payload.toolName))
  } else if (type === 'agent_end') {
    completeOutputs(state)
    activity(state, 'waiting', 'Pi 本轮已结束，等待进程退出')
  }
}

function read(state: Projection, raw: string, timestamp: string, adapter: string): boolean {
  let payload: JsonObject | undefined
  try { payload = object(JSON.parse(raw)) } catch { return false }
  if (!payload) return true
  // Only protocol-owned, top-level session records can establish continuity.
  const sessionId = adapter === 'codex' && payload.type === 'thread.started' ? payload.thread_id
    : adapter === 'claude' && ((payload.type === 'system' && payload.subtype === 'init') || payload.type === 'result') && !payload.parent_tool_use_id ? payload.session_id
      : adapter === 'kimi' && payload.type === 'kimi.session' ? payload.sessionId
        : adapter === 'pi' && payload.type === 'session' ? payload.id : undefined
  if (typeof sessionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) state.sessionId = sessionId
  if (adapter === 'codex') readCodex(state, payload, timestamp)
  if (adapter === 'claude') readClaude(state, payload, timestamp)
  if (adapter === 'kimi') readKimi(state, payload, timestamp)
  if (adapter === 'pi') readPi(state, payload, timestamp)
  return true
}
function consume(state: Projection, event: RuntimeEvent, adapter: string) {
  state.activity.lastEventAt = event.timestamp
  if (event.kind === 'started') { activity(state, 'starting', 'Runtime 已启动'); return }
  if (['completed', 'failed', 'stopped'].includes(event.kind)) { completeOutputs(state); return }
  if (event.kind !== 'stdout') return
  if (adapter === 'generic') {
    state.genericAt ??= event.timestamp
    state.genericText += event.text
    upsert(state, 'stdout', state.genericText, state.genericAt, true)
    activity(state, 'responding', '正在接收 Runtime 输出')
    return
  }
  let text = state.pending + event.text
  let timestamp = state.pendingAt ?? event.timestamp
  // Recover an abandoned malformed partial when the transport later supplies an
  // independently framed complete JSON message. Never discard a real fragment.
  if (state.pending && !event.text.startsWith('\n')) {
    try { if (object(JSON.parse(event.text))) { text = event.text; timestamp = event.timestamp } } catch { /* continuation */ }
  }
  state.pending = ''
  state.pendingAt = undefined
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (!read(state, trimmed, timestamp, adapter) && index === lines.length - 1 && /^[{[]/.test(trimmed)) {
      // Native output is retained in full. Limit just the unfinished frame so
      // one malformed record cannot retain an unbounded concatenation forever.
      if (line.length <= 4 * 1024 * 1024) { state.pending = line; state.pendingAt = timestamp }
    }
    timestamp = event.timestamp
  })
}

function projection(task: Task, run: Run, member: RunMember): Projection {
  let entries = projections.get(task.events)
  if (!entries) { entries = new Map(); projections.set(task.events, entries) }
  const key = route(run, member)
  const cached = entries.get(key)
  if (cached) return cached
  const state = fresh()
  for (const event of task.events) if (event.runId === run.id && event.memberId === member.id) consume(state, event, member.runtime.adapter)
  entries.set(key, state)
  return state
}

/** Replay public text from a saved trace, including formats older UI versions ignored. */
export function getRuntimeOutput(task: Task, run: Run, member: RunMember): PublicOutput[] {
  return projection(task, run, member).outputs.map(output => ({ ...output, streaming: output.streaming && member.status === 'running' }))
}

export function getRuntimeSessionId(task: Task, run: Run, member: RunMember): string | undefined {
  return projection(task, run, member).sessionId ?? member.sessionId
}

/** Advance one isolated route, retaining replay-equivalence on a fresh load. */
export function advanceRuntimeOutput(previous: Task, next: Task, event: RuntimeEvent): PublicOutput[] {
  const run = next.runs.find(item => item.id === event.runId)!
  const member = run.members.find(item => item.id === event.memberId)!
  const state = clone(projection(previous, run, member))
  consume(state, event, member.runtime.adapter)
  const entries = new Map(projections.get(previous.events))
  entries.set(route(run, member), state)
  projections.set(next.events, entries)
  return state.outputs.map(output => ({ ...output, streaming: output.streaming && member.status === 'running' }))
}

const terminalLabels: Record<Exclude<RunStatus, 'running'>, string> = { completed: '执行完成', failed: '执行失败', stopped: '已停止', interrupted: '执行已中断' }
export function getRunActivity(task: Task, run: Run, memberId?: string): RunActivity {
  const members = run.members.filter(member => !memberId || member.id === memberId)
  const running = members.filter(member => member.status === 'running')
  const candidates = running.length ? running : members
  const states = candidates.map(member => ({ member, state: projection(task, run, member) }))
  states.sort((left, right) => (Date.parse(right.state.activity.lastEventAt ?? '') || 0) - (Date.parse(left.state.activity.lastEventAt ?? '') || 0))
  const latest = states[0]
  if (!latest) return { phase: 'waiting', label: '等待 Runtime' }
  if (running.length) return { ...latest.state.activity, memberId: latest.member.id }
  const status = (['failed', 'interrupted', 'stopped', 'completed'] as const).find(value => members.some(member => member.status === value)) ?? 'completed'
  return { phase: status, label: terminalLabels[status], lastEventAt: latest.state.activity.lastEventAt, memberId: latest.member.id }
}
