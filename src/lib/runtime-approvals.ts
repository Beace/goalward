import { invoke } from '@tauri-apps/api/core'
import { getTraceEntries } from './trace-events'
import type { Task } from './types'

export interface RuntimeApproval {
  id: string
  runId: string
  memberId: string
  memberName: string
  title: string
  detail?: string
  options: { optionId: string; name: string; kind: string }[]
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Derive only live requests from the persisted, reassembled ACP frames. */
export function getPendingRuntimeApprovals(task: Task): RuntimeApproval[] {
  const pending = new Map<string, RuntimeApproval>()
  const members = new Map(task.runs.flatMap(run => run.members.filter(member => member.status === 'running' && member.runtime.adapter === 'kimi').map(member => [`${run.id}:${member.id}`, member] as const)))
  if (!members.size) return []
  const liveEvents = task.events.filter(event => members.has(`${event.runId}:${event.memberId}`))
  for (const event of getTraceEntries({ ...task, events: liveEvents })) {
    const member = members.get(`${event.runId}:${event.memberId}`)
    if (!member || event.kind !== 'stdout') continue
    let payload: Record<string, unknown> | undefined
    try { payload = object(JSON.parse(event.text)) } catch { continue }
    const id = typeof payload?.requestId === 'string' ? payload.requestId : ''
    const key = `${event.runId}:${event.memberId}:${id}`
    if (!id) continue
    if (payload?.type === 'kimi.permission_resolved') pending.delete(key)
    if (payload?.type !== 'kimi.permission_requested') continue
    const tool = object(payload.toolCall)
    const options = Array.isArray(payload.options) ? payload.options.map(object).filter(option => typeof option?.optionId === 'string' && typeof option.name === 'string').map(option => ({ optionId: option!.optionId as string, name: option!.name as string, kind: typeof option!.kind === 'string' ? option!.kind : '' })) : []
    if (!options.length) continue
    pending.set(key, {
      id, runId: event.runId, memberId: event.memberId, memberName: member.name,
      title: typeof tool?.title === 'string' ? tool.title : 'Kimi 请求确认工具操作',
      detail: tool?.rawInput === undefined ? undefined : JSON.stringify(tool.rawInput, null, 2), options,
    })
  }
  return [...pending.values()]
}

export async function respondRuntimePermission(request: RuntimeApproval, optionId: string | null) {
  return invoke<void>('respond_runtime_permission', { runId: request.runId, memberId: request.memberId, requestId: request.id, optionId })
}
