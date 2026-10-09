import type { AgentProfile, AgentProfileConfig, AgentProfileRevision } from './agent-types'
import type { Member, Run, RunMember, Settings, Task } from './types'
import { reasoningEfforts, validateReasoning } from './reasoning'

const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
const configFields = ['name', 'role', 'instructions', 'description', 'runtimeId', 'modelId', 'reasoningEffort'] as const
const memberFields = ['name', 'role', 'instructions', 'runtimeId', 'modelId', 'reasoningEffort'] as const
export type AgentMemberField = typeof memberFields[number]

export function agentConfig(profile: AgentProfileConfig): AgentProfileConfig {
  return Object.fromEntries(configFields.map(field => [field, profile[field]])) as unknown as AgentProfileConfig
}

export function validateAgentProfile(profile: AgentProfileConfig, settings: Settings): string | undefined {
  if (!profile.name.trim()) return '请输入 Agent 名称。'
  if (profile.name.trim().length > 80) return 'Agent 名称最多 80 个字符。'
  if (!profile.role.trim()) return '请输入职责。'
  const runtime = settings.runtimes.find(item => item.id === profile.runtimeId)
  if (!runtime) return '请选择已登记的 Runtime。'
  const model = settings.models.find(item => item.enabled && item.runtimeIds.includes(runtime.id) && item.modelId === (profile.modelId || runtime.defaultModel))
  // Existing model identifiers are intentionally retained when the catalog changes.
  return validateReasoning(runtime, model, profile.reasoningEffort ?? model?.reasoningEffort ?? 'inherit')
}

export function createAgentProfile(settings: Settings, input: Partial<AgentProfileConfig> & { name: string; assignedGoalIds?: string[] }): AgentProfile {
  const runtime = settings.runtimes.find(item => item.id === (input.runtimeId || settings.defaultRuntime)) ?? settings.runtimes[0]
  const time = now()
  const config: AgentProfileConfig = {
    name: input.name.trim(), role: input.role?.trim() || '执行', instructions: input.instructions?.trim() || '',
    description: input.description?.trim() || '', runtimeId: input.runtimeId || runtime?.id || '',
    modelId: input.modelId ?? '', reasoningEffort: input.reasoningEffort,
  }
  const error = validateAgentProfile(config, settings)
  if (error) throw new Error(error)
  return { ...config, id: id(), version: 1, enabled: true, assignedGoalIds: [...new Set(input.assignedGoalIds ?? [])], createdAt: time, updatedAt: time,
    history: [{ version: 1, createdAt: time, summary: '创建档案', snapshot: agentConfig(config) }] }
}

export function updateAgentProfile(profile: AgentProfile, patch: Partial<AgentProfileConfig>, settings: Settings): AgentProfile {
  const config = agentConfig({ ...profile, ...patch })
  config.name = config.name.trim(); config.role = config.role.trim(); config.instructions = config.instructions.trim(); config.description = config.description.trim()
  const error = validateAgentProfile(config, settings)
  if (error) throw new Error(error)
  const changed = configFields.filter(field => config[field] !== profile[field])
  if (!changed.length) return profile
  const version = profile.version + 1, time = now()
  const labels: Record<typeof configFields[number], string> = { name: '名称', role: '职责', instructions: '职责指令', description: '说明', runtimeId: 'Runtime', modelId: '模型', reasoningEffort: '思考强度' }
  return { ...profile, ...config, version, updatedAt: time,
    history: [...profile.history, { version, createdAt: time, summary: `更新${changed.map(field => labels[field]).join('、')}`, snapshot: agentConfig(config) }] }
}

export function duplicateAgentProfile(profile: AgentProfile): AgentProfile {
  const time = now(), config = agentConfig({ ...profile, name: `${profile.name.slice(0, 75)} 副本` })
  return { ...config, id: id(), enabled: true, assignedGoalIds: [], version: 1, createdAt: time, updatedAt: time,
    history: [{ version: 1, createdAt: time, summary: `复制自 ${profile.name} v${profile.version}`, snapshot: agentConfig(config) }] }
}

export function memberFromAgent(profile: AgentProfile): Member {
  if (!profile.enabled) throw new Error('此 Agent 已停用，请先启用后再分配。')
  const { name, role, instructions, runtimeId, modelId, reasoningEffort } = profile
  return { id: id(), name, role, instructions, runtimeId, modelId, reasoningEffort, agentProfileId: profile.id, agentProfileVersion: profile.version }
}

/** Explicitly refresh inherited fields. Task overrides and all historical runs stay untouched. */
export function updateMemberFromAgent(member: Member, profile: AgentProfile): { member: Member; preservedFields: AgentMemberField[] } {
  if (member.agentProfileId !== profile.id) throw new Error('任务成员未关联此 Agent 档案。')
  const previous = profile.history.find(item => item.version === member.agentProfileVersion)?.snapshot
  if (!previous) throw new Error('找不到成员引用的档案版本，无法安全保留任务覆盖。请重新选择档案。')
  const next: Member = { ...member, agentProfileVersion: profile.version }
  const preservedFields: AgentMemberField[] = []
  // Runtime, model and effort are a compatibility group. A task override of any of
  // them retains the whole group; refreshing only one could create an invalid pair.
  const executionFields = ['runtimeId', 'modelId', 'reasoningEffort'] as const
  const executionOverridden = executionFields.some(field => member[field] !== previous[field])
  for (const field of memberFields) {
    if ((executionFields as readonly string[]).includes(field) && executionOverridden || member[field] !== previous[field]) preservedFields.push(field)
    else Object.assign(next, { [field]: profile[field] })
  }
  return { member: next, preservedFields }
}

export function agentFromMember(member: Member, settings: Settings, name = member.name): AgentProfile {
  return createAgentProfile(settings, { name, role: member.role, instructions: member.instructions || '', runtimeId: member.runtimeId, modelId: member.modelId, reasoningEffort: member.reasoningEffort })
}

export interface AgentExecution { task: Task; run: Run; member: RunMember }
export function agentActivity(profileId: string, tasks: Task[]) {
  const executions: AgentExecution[] = tasks.filter(task => !task.demo).flatMap(task => task.runs.flatMap(run => run.members.filter(member => member.agentProfileId === profileId).map(member => ({ task, run, member }))))
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
  return { executions, active: executions.filter(entry => entry.member.status === 'running'),
    tasks: tasks.filter(task => !task.demo && (task.members.some(member => member.agentProfileId === profileId) || task.runs.some(run => run.members.some(member => member.agentProfileId === profileId)))) }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
function readConfig(value: Record<string, unknown>, settings: Settings): AgentProfileConfig {
  return { name: text(value.name, '未命名 Agent'), role: text(value.role, '执行'), instructions: text(value.instructions), description: text(value.description), runtimeId: text(value.runtimeId, settings.defaultRuntime), modelId: text(value.modelId),
    ...(reasoningEfforts.includes(value.reasoningEffort as never) ? { reasoningEffort: value.reasoningEffort as AgentProfileConfig['reasoningEffort'] } : {}) }
}

/** Migration only restores saved profiles. It never manufactures agents or infers links from runtime names. */
export function normalizeAgentProfiles(raw: unknown, settings: Settings): AgentProfile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.filter(record).filter(value => typeof value.id === 'string' && value.id && !seen.has(value.id) && Boolean(seen.add(value.id))).map(value => {
    const version = Number.isSafeInteger(value.version) && Number(value.version) > 0 ? Number(value.version) : 1
    const createdAt = text(value.createdAt, now()), config = readConfig(value, settings)
    const history: AgentProfileRevision[] = Array.isArray(value.history) ? value.history.filter(record).filter(item => Number.isSafeInteger(item.version) && Number(item.version) > 0 && Number(item.version) <= version && record(item.snapshot)).map(item => ({ version: Number(item.version), createdAt: text(item.createdAt, createdAt), summary: text(item.summary, '已保存版本'), snapshot: readConfig(item.snapshot as Record<string, unknown>, settings) })) : []
    if (!history.some(item => item.version === version)) history.push({ version, createdAt: text(value.updatedAt, createdAt), summary: '已保存版本', snapshot: agentConfig(config) })
    return { ...config, id: String(value.id), version, enabled: value.enabled !== false, createdAt, updatedAt: text(value.updatedAt, createdAt),
      assignedGoalIds: Array.isArray(value.assignedGoalIds) ? [...new Set(value.assignedGoalIds.filter((entry): entry is string => typeof entry === 'string'))] : [], history }
  })
}
