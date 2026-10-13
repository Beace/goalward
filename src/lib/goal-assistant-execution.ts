import type { GoalAssistantPhase } from './goal-assistant'
import { goalAssistantMessageText } from './goal-assistant'
import { getTraceEntries, type TraceEntry } from './trace-events'
import type { Run, RunMember, Task } from './types'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Select the latest request first: an earlier planning call must not stand in for a newer clarification. */
export function getGoalAssistantRun(task: Task | undefined, goalId: string, phase: GoalAssistantPhase = 'plan'): Run | undefined {
  if (!task || task.kind !== 'goal_assistant' || task.goalId !== goalId) return undefined
  const run = task.runs.at(-1)
  return run?.context?.goal?.id === goalId && run.context.goal.assistant?.requestPhase === phase ? run : undefined
}

export interface GoalAssistantTokenUsage {
  input?: number
  cachedInput?: number
  output?: number
  reasoningOutput?: number
  total?: number
}
export interface GoalAssistantInvocation {
  member: RunMember
  threadId?: string
  turnId?: string
  /** Reported by the native session/message; distinct from the saved request selection. */
  nativeModel?: string
  nativeProvider?: string
  nativeSessionReasoning?: string
  latestUsage?: GoalAssistantTokenUsage
  conversationUsage?: GoalAssistantTokenUsage
  modelContextWindow?: number
}

function usage(value: unknown): GoalAssistantTokenUsage | undefined {
  const source = object(value)
  if (!source) return undefined
  const result: GoalAssistantTokenUsage = { input: count(source.inputTokens), cachedInput: count(source.cachedInputTokens), output: count(source.outputTokens), reasoningOutput: count(source.reasoningOutputTokens), total: count(source.totalTokens) }
  return Object.values(result).some(item => item !== undefined) ? result : undefined
}

function messageUsage(value: unknown, adapter: 'claude' | 'pi'): GoalAssistantTokenUsage | undefined {
  const source = object(value)
  if (!source) return undefined
  const result: GoalAssistantTokenUsage = adapter === 'claude'
    ? { input: count(source.input_tokens), cachedInput: count(source.cache_read_input_tokens), output: count(source.output_tokens) }
    : { input: count(source.input), cachedInput: count(source.cacheRead), output: count(source.output), total: count(source.totalTokens) }
  return Object.values(result).some(item => item !== undefined) ? result : undefined
}

function frame(entry: TraceEntry): ObjectValue | undefined {
  if (entry.kind !== 'stdout') return undefined
  try { return object(JSON.parse(entry.text)) } catch { return undefined }
}

/** Raw native output can split a JSON frame across chunks; the shared trace parser owns reconstruction. */
export function getGoalAssistantInvocations(task: Task, run: Run): GoalAssistantInvocation[] {
  const entries = getTraceEntries(task, run).filter(entry => entry.taskId === task.id)
  return run.members.map(member => {
    const result: GoalAssistantInvocation = { member, threadId: member.sessionId }
    for (const entry of entries) {
      if (entry.memberId !== member.id) continue
      const payload = frame(entry)
      if (!payload) continue
      if (member.runtime.adapter === 'claude') {
        const sessionId = text(payload.session_id)
        if (sessionId && result.threadId && sessionId !== result.threadId) continue
        if (sessionId) result.threadId = sessionId
        if (payload.type === 'system' && payload.subtype === 'init') result.nativeModel = text(payload.model) ?? result.nativeModel
        if (payload.type === 'assistant') {
          const message = object(payload.message)
          result.nativeModel = text(message?.model) ?? result.nativeModel
          result.latestUsage = messageUsage(message?.usage, 'claude') ?? result.latestUsage
        }
        if (payload.type === 'result') result.latestUsage = messageUsage(payload.usage, 'claude') ?? result.latestUsage
        continue
      }
      if (member.runtime.adapter === 'pi') {
        if (payload.type === 'runtime.session_ready') {
          const sessionId = text(payload.sessionId)
          if (!sessionId || (result.threadId && result.threadId !== sessionId)) continue
          result.threadId = sessionId
          const model = object(payload.model)
          result.nativeModel = text(model?.id)
          result.nativeProvider = text(model?.provider)
          result.nativeSessionReasoning = text(payload.reasoningEffort)
        }
        if (payload.type === 'message_end') {
          const message = object(payload.message)
          if (message?.role !== 'assistant') continue
          result.nativeModel = text(message.model) ?? result.nativeModel
          result.nativeProvider = text(message.provider) ?? result.nativeProvider
          result.latestUsage = messageUsage(message.usage, 'pi') ?? result.latestUsage
        }
        continue
      }
      if (payload.type === 'codex.app_server.thread_ready') {
        const threadId = text(payload.threadId)
        if (!threadId || (result.threadId && result.threadId !== threadId)) continue
        result.threadId = threadId
        result.nativeModel = text(payload.model)
        result.nativeProvider = text(payload.modelProvider)
        result.nativeSessionReasoning = text(payload.reasoningEffort)
      }
      const params = object(payload.params)
      if (!params || !result.threadId || params.threadId !== result.threadId) continue
      if (payload.method === 'turn/started') {
        const turnId = text(object(params.turn)?.id)
        if (!turnId) continue
        // A later turn cannot inherit token usage from an earlier one.
        if (result.turnId !== turnId) {
          result.turnId = turnId
          result.latestUsage = undefined
          result.conversationUsage = undefined
          result.modelContextWindow = undefined
        }
      }
      if (payload.method === 'thread/tokenUsage/updated' && result.turnId && params.turnId === result.turnId) {
        const source = object(params.tokenUsage)
        if (!source) continue
        result.latestUsage = usage(source.last)
        result.conversationUsage = usage(source.total)
        result.modelContextWindow = count(source.modelContextWindow)
      }
      if (payload.method === 'model/rerouted' && result.turnId && params.turnId === result.turnId) {
        result.nativeModel = text(params.toModel) ?? result.nativeModel
      }
    }
    return result
  })
}

/** This run's public response only. Internal action JSON and reasoning messages never become visible prose. */
export function getGoalAssistantRunResponse(task: Task, run: Run): string {
  const memberIds = new Set(run.members.map(member => member.id))
  return task.messages.filter(message => message.runId === run.id && message.role === 'assistant' && message.kind !== 'reasoning' && (!message.memberId || memberIds.has(message.memberId)))
    .map(message => goalAssistantMessageText(message.text)).filter(Boolean).join('\n\n')
}
