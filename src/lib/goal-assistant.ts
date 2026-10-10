import type { AppState, RuntimeConfig, Settings, Task } from './types'
import type { Goal, GoalAssistantDraft, GoalAssistantState, GoalTaskProposal } from './goal-types'
import { createTask } from './domain'
import { reviseGoal, updateGoalState } from './goals'
import { createWorkspaceTask, setTaskDependencies } from './workspace'
import { translate } from '@/i18n'

export type { GoalAssistantDraft, GoalAssistantState, GoalTaskProposal } from './goal-types'
export type GoalAssistantPhase = 'clarify' | 'plan'
export interface GoalAssistantDraftSource { goalVersion: number; stateVersion: number }
export interface GoalAssistantAction { phase: GoalAssistantPhase; baseGoalVersion: number; draft?: GoalAssistantDraft; proposals?: GoalTaskProposal[] }
const clone = <T,>(value: T): T => structuredClone(value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const fail = (zh: string, en: string): never => { throw new Error(translate(zh, en)) }
const text = (value: unknown, field: string, required = false): string => {
  if (typeof value !== 'string' || value.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail(`${field} 必须是有效文本。`, `${field} must be valid text.`)
  const result = value.trim()
  if (required && !result) return fail(`${field} 不能为空。`, `${field} cannot be empty.`)
  return result
}
function object(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${name} 格式无效。`, `Invalid ${name}.`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key))) return fail(`${name} 包含未支持的字段。`, `${name} contains unsupported fields.`)
  return record
}
export function validateGoalAssistantDate(value: unknown, label = 'deadline'): string {
  const date = text(value, label)
  if (!date) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(`${label} 必须是 YYYY-MM-DD 日期或留空。`, `${label} must be a YYYY-MM-DD date or empty.`)
  const instant = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date || date < '0001-01-01') return fail(`${label} 日期不存在。`, `${label} is not a real date.`)
  return date
}
export function validateGoalAssistantDraft(value: unknown): GoalAssistantDraft {
  const input = object(value, ['title', 'intent', 'expected', 'constraints', 'deadline', 'currentSummary', 'criteria'], '目标草案')
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 50) return fail('目标草案需要 1–50 项完成标准。', 'A goal draft needs 1–50 success criteria.')
  const criteria = input.criteria.map(value => {
    const item = object(value, ['text', 'baseline', 'target', 'method'], '完成标准')
    return { text: text(item.text, '完成标准', true), baseline: text(item.baseline, '当前基线'), target: text(item.target, '达成标准', true), method: text(item.method, '检验方式', true) }
  })
  if (new Set(criteria.map(item => item.text)).size !== criteria.length) return fail('完成标准不能重复。', 'Success criteria cannot be duplicated.')
  return { title: text(input.title, '目标名称', true), intent: text(input.intent, '目标意图'), expected: text(input.expected, '预期结果', true), constraints: text(input.constraints, '约束'), deadline: validateGoalAssistantDate(input.deadline), currentSummary: text(input.currentSummary, '当前现状'), criteria }
}
function proposalInput(value: unknown, goalVersion: number): GoalTaskProposal {
  const input = object(value, ['id', 'title', 'delivery', 'acceptance', 'deadline', 'dependsOn'], '任务建议')
  const id = text(input.id, '建议标识', true)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return fail('任务建议标识无效。', 'Invalid task proposal identifier.')
  if (!Array.isArray(input.dependsOn) || input.dependsOn.length > 100 || input.dependsOn.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item))) return fail('任务依赖格式无效。', 'Invalid task dependencies.')
  if (new Set(input.dependsOn).size !== input.dependsOn.length) return fail('任务依赖不能重复。', 'Task dependencies cannot be duplicated.')
  return { id, title: text(input.title, '任务名称', true), delivery: text(input.delivery, '预期产物', true), acceptance: text(input.acceptance, '任务验收', true), deadline: validateGoalAssistantDate(input.deadline), dependsOn: [...input.dependsOn] as string[], status: 'suggested', baseGoalVersion: goalVersion }
}
export function validateGoalTaskProposals(proposals: GoalTaskProposal[], goal: Pick<Goal, 'deadline' | 'version'>): void {
  if (!Array.isArray(proposals) || proposals.length > 100) return fail('任务建议列表无效。', 'Invalid task proposal list.')
  const byId = new Map<string, GoalTaskProposal>()
  for (const proposal of proposals) {
    proposalInput({ id: proposal.id, title: proposal.title, delivery: proposal.delivery, acceptance: proposal.acceptance, deadline: proposal.deadline, dependsOn: proposal.dependsOn }, goal.version)
    if (byId.has(proposal.id)) return fail('任务建议标识不能重复。', 'Task proposal identifiers cannot be duplicated.')
    if (!['suggested', 'adopted', 'dismissed'].includes(proposal.status)) return fail('任务建议状态无效。', 'Invalid task proposal status.')
    if (proposal.status !== 'adopted' && proposal.baseGoalVersion !== goal.version) return fail('任务建议基于旧版目标，请重新整理。', 'Task suggestions are based on an older goal. Generate them again.')
    if (proposal.status !== 'adopted' && goal.deadline && proposal.deadline && proposal.deadline > goal.deadline) return fail('任务截止日期不能晚于目标 DDL。', 'Task deadlines cannot be later than the goal deadline.')
    byId.set(proposal.id, proposal)
  }
  const complete = new Set<string>()
  function visit(id: string, ancestors: Set<string>) {
    if (ancestors.has(id)) return fail('任务依赖不能形成循环。', 'Task dependencies cannot form a cycle.')
    if (complete.has(id)) return
    const proposal = byId.get(id)
    if (!proposal) return fail('任务依赖引用了不存在的建议。', 'A task dependency references a missing suggestion.')
    for (const dependency of proposal.dependsOn) {
      const before = byId.get(dependency)
      if (before?.deadline && proposal.deadline && before.deadline > proposal.deadline) return fail('后续任务的截止日期不能早于前置任务。', 'A dependent task cannot be due before its prerequisite.')
      visit(dependency, new Set([...ancestors, id]))
    }
    complete.add(id)
  }
  proposals.forEach(proposal => visit(proposal.id, new Set()))
}

function mergePlanningProposals(previous: GoalTaskProposal[], incoming: GoalTaskProposal[], goalVersion: number): GoalTaskProposal[] {
  const adopted = previous.filter(item => item.status === 'adopted')
  if (incoming.some(item => adopted.some(old => old.id === item.id))) return fail('新建议与已采用任务的标识重复，请重新整理。', 'New suggestions reuse an adopted task identifier. Generate them again.')
  const edited = previous.filter(item => item.status === 'suggested' && item.edited).map(item => ({ ...item, baseGoalVersion: goalVersion }))
  const retainedIds = new Set([...adopted, ...edited].map(item => item.id))
  return [...adopted, ...edited, ...incoming.filter(item => !retainedIds.has(item.id))]
}

/** The action must be the last Markdown block. No status, evidence or task IDs are trusted. */
export function parseGoalAssistantResponse(response: string, baseGoalVersion: number, phase?: GoalAssistantPhase, goalDeadline = '', previousProposals: GoalTaskProposal[] = []): GoalAssistantAction {
  if (typeof response !== 'string' || response.length > 1024 * 1024) return fail('助手回复格式无效。', 'Invalid assistant reply.')
  const matches = [...response.matchAll(/^```goalward[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)]
  if (matches.length !== 1 || response.slice(matches[0].index! + matches[0][0].length).trim()) return fail('助手回复缺少唯一的末尾 goalward JSON，请重试。', 'The reply needs one final goalward JSON block. Please retry.')
  let raw: unknown
  try { raw = JSON.parse(matches[0][1]) } catch { return fail('助手的结构化建议不是有效 JSON，请重试。', 'The structured suggestion is not valid JSON. Please retry.') }
  const input = object(raw, ['type', 'baseGoalVersion', 'draft', 'proposals'], '助手建议')
  if (!Number.isInteger(baseGoalVersion) || baseGoalVersion < 1 || input.baseGoalVersion !== baseGoalVersion) return fail('助手建议的目标版本不匹配，请重新整理。', 'The suggestion references a different goal version. Generate it again.')
  if (input.type !== 'clarify' && input.type !== 'plan') return fail('助手建议类型无效。', 'Invalid assistant action type.')
  if (phase && input.type !== phase) return fail('助手回复与本次请求不匹配，请重试。', 'The reply does not match this request. Please retry.')
  if (input.type === 'clarify') {
    if ('proposals' in input || !('draft' in input)) return fail('澄清回复格式无效。', 'Invalid clarification reply.')
    return { phase: 'clarify', baseGoalVersion, ...(input.draft === null ? {} : { draft: validateGoalAssistantDraft(input.draft) }) }
  }
  if ('draft' in input || !Array.isArray(input.proposals) || !input.proposals.length || input.proposals.length > 100) return fail('拆分回复需要非空任务建议。', 'A planning reply needs task suggestions.')
  const proposals = input.proposals.map(value => proposalInput(value, baseGoalVersion))
  validateGoalTaskProposals(mergePlanningProposals(previousProposals, proposals, baseGoalVersion), { deadline: goalDeadline, version: baseGoalVersion })
  return { phase: 'plan', baseGoalVersion, proposals }
}

/** Restrict the per-request clone. Shared user settings and historic Run snapshots stay intact. */
export function goalAssistantRuntime(source: RuntimeConfig): RuntimeConfig {
  const runtime = clone(source)
  if (!runtime.enabled || !runtime.executable.trim()) return fail('请先连接一个可用 Runtime。', 'Connect an available runtime first.')
  if (runtime.adapter === 'codex') {
    runtime.args = []
    runtime.permissions = { codex: { sandbox: 'read-only', network: 'inherit', additionalDirectories: [] } }
  } else if (runtime.adapter === 'claude') {
    runtime.args = []
    runtime.permissions = { claude: { mode: 'plan', additionalDirectories: [], allowedTools: [], disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] } }
  } else if (runtime.adapter === 'pi') {
    runtime.args = ['--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']
    runtime.permissions = undefined
  } else if (runtime.adapter === 'kimi') {
    runtime.args = []
    runtime.permissions = { kimi: { mode: 'manual' } }
  } else return fail('通用 CLI 尚未支持受限目标对话，请选择内置 Runtime。', 'Choose a built-in runtime for restricted goal conversations; generic CLIs are not supported yet.')
  return runtime
}
export function createGoalAssistantTask(settings: Settings, input: { goalId: string; directory: string; runtimeId?: string }): Task {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.goalId)) return fail('目标标识无效。', 'Invalid goal identifier.')
  if (!input.directory.startsWith('/')) return fail('目标助手需要应用管理的绝对工作目录。', 'The goal assistant needs an app-managed absolute working directory.')
  const source = settings.runtimes.find(item => item.id === (input.runtimeId || settings.defaultRuntime))
  if (!source) return fail('未找到目标助手 Runtime。', 'The goal assistant runtime was not found.')
  const runtime = goalAssistantRuntime(source)
  const task = createTask({ ...settings, defaultRuntime: runtime.id, runtimes: [runtime] }, translate('目标助手', 'Goal assistant'), input.directory, 'solo')
  return { ...task, kind: 'goal_assistant', goalId: input.goalId, businessStatus: 'todo', executor: 'agent', acceptance: translate('形成待用户确认的目标或任务建议，不执行项目修改。', 'Produce goal or task suggestions for the user to confirm without changing the project.'), results: [], dependencies: [], plan: [] }
}
export function goalAssistantPrompt(goal: Goal, phase: GoalAssistantPhase, input = ''): string {
  const schema = phase === 'clarify'
    ? { type: 'clarify', baseGoalVersion: goal.version, draft: { title: '目标名称', intent: '为什么做', expected: '预期结果', constraints: '范围和约束', deadline: '', currentSummary: '已知情况与未知', criteria: [{ text: '完成条件', baseline: '已知基线或待确认', target: '可检查的达成标准', method: '如何验证' }] } }
    : { type: 'plan', baseGoalVersion: goal.version, proposals: [{ id: 'step-1', title: '下一步行动', delivery: '预期产物', acceptance: '验收方式', deadline: '', dependsOn: [] }] }
  return [
    '你是 Goalward 的目标助手。帮助用户把模糊方向变成明确目标，再形成可执行任务。所有内容只是待确认建议。',
    '当前工作目录由应用管理，仅用于目标对话。不得修改用户项目、读取未提供的项目文件、运行实现命令、安装程序或宣称已完成调查。只基于对话和用户明确提供的资料推理；缺乏依据时明确写未知。不得执行建议任务。',
    phase === 'clarify' ? '优先询问最影响下一步的一个问题，减少表单负担。信息足够时整理目标草案；不能确定时继续追问并将 draft 设为 null。成功标准需可检查，不强制数字指标，不编造现状。' : '根据用户已确认的目标主动拆分任务，说明每项产物和验收。建议日期使用 YYYY-MM-DD；不能决定时留空。任务日期不能晚于目标日期；前置依赖可引用本次新建议、已采用任务或用户修改后保留的建议 id，必须无环。已采用任务和 edited=true 的待采用建议由应用保留，不要重复或改写它们；如被保留建议依赖尚未采用的其他步骤，必须在新建议中保留对应 id 和合理日期。',
    '在正常可读回复的末尾输出且只输出一个独立 ```goalward 代码块，内容严格遵循以下 JSON 结构；不要添加状态、已验收依据、taskId 或任何多余字段。clarify 的 draft 可以为 null，plan 的 proposals 不能为空。代码块之后不得输出其他内容。',
    JSON.stringify(schema, null, 2),
    `已保存目标与用户提供现状：\n${JSON.stringify({ id: goal.id, version: goal.version, title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, criteria: goal.criteria, currentState: goal.currentState, currentTaskProposals: goal.assistant?.proposals }, null, 2)}`,
    `本轮用户输入：\n${input.trim() || (phase === 'plan' ? '请整理实现这个目标需要的任务，等待我采用。' : goal.title)}`,
  ].join('\n\n')
}

export function processGoalAssistantRun(state: AppState, goalId: string, runId: string): AppState {
  const goal = state.goals.find(item => item.id === goalId)
  if (!goal?.assistant?.taskId || goal.assistant.processedRunId === runId) return state
  const task = state.tasks.find(item => item.id === goal.assistant!.taskId)
  const run = task?.runs.find(item => item.id === runId)
  if (!task || task.kind !== 'goal_assistant' || task.goalId !== goalId || task.historyPending || !run || task.runs.at(-1)?.id !== runId || !run.members.length || run.members.some(item => item.status !== 'completed')) return state
  const source = run.context?.goal
  const phase = source?.assistant?.requestPhase ?? goal.assistant.requestPhase
  if (!phase) return state
  let assistant: GoalAssistantState = { ...goal.assistant, processedRunId: runId, requestPhase: undefined, error: undefined }
  try {
    if (!source || source.id !== goalId || source.version !== goal.version) throw new Error(translate('目标已修订，已保留最新内容；请重新整理建议。', 'The goal changed. Your latest content was kept; generate suggestions again.'))
    if (source.currentState?.version !== goal.currentState.version) fail('现状已更新，已保留最新内容；请重新整理建议。', 'Context changed. Your latest content was kept; generate suggestions again.')
    if (goal.assistant.requestPhase && goal.assistant.requestPhase !== phase) fail('已开始新的请求，旧建议未覆盖当前内容。', 'A newer request has started; the earlier suggestion did not replace it.')
    const currentContent = phase === 'clarify' ? goal.assistant.draft : goal.assistant.proposals
    const sourceContent = phase === 'clarify' ? source.assistant?.draft : source.assistant?.proposals
    if (!same(currentContent, sourceContent)) fail('已保留你在回复期间的修改；请核对回复或重新整理。', 'Your edits during the reply were kept. Review the reply or generate it again.')
    const messages = task.messages.filter(item => item.role === 'assistant' && item.runId === runId && item.kind !== 'reasoning')
    if (!messages.length || messages.some(item => item.streaming)) fail('助手没有完整回复，请重试。', 'The assistant did not return a complete reply. Please retry.')
    const action = parseGoalAssistantResponse(messages.map(item => item.text).join('\n\n'), source.version, phase, goal.deadline, goal.assistant.proposals)
    if (action.draft) assistant = { ...assistant, draft: clone(action.draft), draftGoalVersion: source.version, draftStateVersion: source.currentState.version }
    if (action.proposals) {
      assistant.proposals = mergePlanningProposals(goal.assistant.proposals ?? [], action.proposals, goal.version)
    }
  } catch (error) { assistant = { ...assistant, error: error instanceof Error ? error.message : String(error) } }
  return { ...state, goals: state.goals.map(item => item.id === goalId ? { ...item, assistant } : item) }
}

export function confirmGoalAssistantDraft(state: AppState, goalId: string, input?: GoalAssistantDraft, source?: GoalAssistantDraftSource): AppState {
  const goal = state.goals.find(item => item.id === goalId)
  if (!goal) return fail('目标不存在。', 'Goal not found.')
  const goalVersion = source?.goalVersion ?? goal.assistant?.draftGoalVersion ?? goal.version
  const stateVersion = source?.stateVersion ?? goal.assistant?.draftStateVersion ?? goal.currentState.version
  if (goalVersion !== goal.version || stateVersion !== goal.currentState.version) return fail('目标或现状已更新，请核对最新草案后确认。', 'The goal or context changed. Review the latest draft before confirming.')
  const draft = validateGoalAssistantDraft(input ?? goal.assistant?.draft)
  const currentDraft: GoalAssistantDraft = { title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, currentSummary: goal.currentState.summary, criteria: goal.criteria.map(item => ({ text: item.text, baseline: item.baseline ?? '', target: item.target ?? '', method: item.method ?? '' })) }
  if (goal.assistant?.confirmedVersion === goal.version && same(draft, currentDraft)) {
    if (same(goal.assistant.draft, draft) && goal.assistant.draftGoalVersion === goal.version && goal.assistant.draftStateVersion === goal.currentState.version) return state
    const assistant = { ...goal.assistant, draft: clone(draft), draftGoalVersion: goal.version, draftStateVersion: goal.currentState.version, requestPhase: undefined, error: undefined }
    return { ...state, goals: state.goals.map(item => item.id === goalId ? { ...item, assistant } : item) }
  }
  let next = reviseGoal(goal, { ...draft, criteria: draft.criteria, reason: translate('用户确认助手整理的目标', 'User confirmed the goal prepared by the assistant') })
  if (draft.currentSummary !== goal.currentState.summary) next = updateGoalState(next, { summary: draft.currentSummary, reason: translate('用户确认当前现状', 'User confirmed current context') })
  next = { ...next, status: 'active', assistant: { ...goal.assistant, draft: clone(draft), draftGoalVersion: next.version, draftStateVersion: next.currentState.version, confirmedVersion: next.version, requestPhase: undefined, error: undefined } }
  return { ...state, goals: state.goals.map(item => item.id === goalId ? next : item) }
}
export function adoptGoalTaskProposals(state: AppState, goalId: string, proposalIds?: string[]): AppState {
  const goal = state.goals.find(item => item.id === goalId)
  if (!goal?.assistant) return fail('请先确认目标并整理任务建议。', 'Confirm the goal and generate task suggestions first.')
  if (goal.assistant.confirmedVersion !== goal.version) return fail('请先确认最新目标，再采用任务建议。', 'Confirm the latest goal before adopting task suggestions.')
  const proposals = goal.assistant.proposals ?? []
  const ids = new Set(proposalIds ?? proposals.filter(item => item.status === 'suggested').map(item => item.id))
  if (!ids.size) return state
  if ([...ids].some(id => !proposals.some(item => item.id === id))) return fail('任务建议不存在。', 'Task suggestion not found.')
  const selected = proposals.filter(item => ids.has(item.id) && item.status === 'suggested')
  if (!selected.length) return state
  // Adopted suggestions retain source history and remain valid dependency targets.
  const planning = proposals.filter(item => item.status !== 'dismissed')
  validateGoalTaskProposals(planning, goal)
  const taskIds = new Map(proposals.filter(item => item.status === 'adopted' && item.taskId).map(item => [item.id, item.taskId!]))
  const selectedIds = new Set(selected.map(item => item.id))
  for (const item of selected) for (const dependency of item.dependsOn) {
    if (!selectedIds.has(dependency) && !taskIds.has(dependency)) return fail('请先采用前置任务，或一起采用这份计划。', 'Adopt prerequisite tasks first, or adopt the plan together.')
    const existing = taskIds.get(dependency)
    if (existing && !state.tasks.some(task => task.id === existing)) return fail('前置任务已删除，请先调整建议依赖。', 'A prerequisite task was deleted. Adjust the suggested dependencies first.')
  }
  const created = selected.map(item => {
    const task = { ...createWorkspaceTask(state.settings, { title: item.title, goalId, acceptance: item.acceptance }), deadline: item.deadline, delivery: item.delivery, requirementsVersion: 0 }
    taskIds.set(item.id, task.id)
    return task
  })
  let next = { ...state, tasks: [...created, ...state.tasks] }
  selected.forEach(item => { next = setTaskDependencies(next, taskIds.get(item.id)!, item.dependsOn.map(id => taskIds.get(id)!)) })
  const assistant = { ...goal.assistant, proposals: proposals.map(item => ids.has(item.id) && item.status === 'suggested' ? { ...item, status: 'adopted' as const, taskId: taskIds.get(item.id) } : item), error: undefined }
  return { ...next, goals: next.goals.map(item => item.id === goalId ? { ...item, assistant } : item) }
}
export function adoptGoalTaskProposal(state: AppState, goalId: string, proposalId: string): AppState { return adoptGoalTaskProposals(state, goalId, [proposalId]) }
export function dismissGoalTaskProposal(state: AppState, goalId: string, proposalId: string): AppState {
  const goal = state.goals.find(item => item.id === goalId)
  const proposal = goal?.assistant?.proposals?.find(item => item.id === proposalId)
  if (!goal || !proposal) return fail('任务建议不存在。', 'Task suggestion not found.')
  if (proposal.status !== 'suggested') return state
  if (goal.assistant!.proposals!.some(item => item.status === 'suggested' && item.dependsOn.includes(proposalId))) return fail('还有建议依赖这项任务，请先调整依赖。', 'Other suggestions depend on this task. Adjust their dependencies first.')
  return { ...state, goals: state.goals.map(item => item.id === goalId ? { ...item, assistant: { ...item.assistant, proposals: item.assistant!.proposals!.map(item => item.id === proposalId ? { ...item, status: 'dismissed' } : item) } } : item) }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
/** Three-way rollback: only undo values still equal to this failed optimistic write. */
function rollbackValue(current: unknown, before: unknown, applied: unknown): unknown {
  if (same(before, applied)) return current
  if (same(current, applied)) return before
  if (record(current) && record(applied) && (before === undefined || record(before))) {
    const result = { ...current }, original = record(before) ? before : {}
    for (const key of new Set([...Object.keys(original), ...Object.keys(applied)])) {
      const value = rollbackValue(current[key], original[key], applied[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  if (Array.isArray(current) && Array.isArray(before) && Array.isArray(applied)
    && [...current, ...before, ...applied].every(item => record(item) && typeof item.id === 'string')) {
    const original = new Map(before.map(item => [item.id, item])), failed = new Map(applied.map(item => [item.id, item]))
    const result = current.flatMap(item => {
      const value = rollbackValue(item, original.get(item.id), failed.get(item.id))
      return value === undefined ? [] : [value]
    })
    for (const item of before) if (!failed.has(item.id) && !current.some(value => value.id === item.id)) result.push(item)
    return result
  }
  return current
}
/** Restore a failed Goal edit/adoption without removing concurrent edits or Runtime history. */
export function rollbackGoalAssistantAction(current: AppState, before: AppState, applied: AppState): AppState {
  const originalTasks = new Set(before.tasks.map(item => item.id))
  const addedTasks = new Map(applied.tasks.filter(item => !originalTasks.has(item.id)).map(item => [item.id, item]))
  const retainedTasks = new Set<string>()
  const tasks = current.tasks.filter(task => {
    const added = addedTasks.get(task.id)
    if (!added) return true
    // Even one message/event/result or pending recovery can represent durable work.
    const keep = Boolean(task.historyPending || task.runs.length || task.messages.length || task.events.length || task.results?.length || task.artifacts?.length || !same(task, added))
    if (keep) retainedTasks.add(task.id)
    return keep
  })
  const originalGoals = new Map(before.goals.map(item => [item.id, item])), failedGoals = new Map(applied.goals.map(item => [item.id, item]))
  const goals = current.goals.flatMap(goal => {
    const original = originalGoals.get(goal.id), failed = failedGoals.get(goal.id)
    if (!failed) return [goal]
    if (!original) {
      // A new Goal that gained edits or execution after this action must survive.
      return same(goal, failed) && !tasks.some(task => task.goalId === goal.id) ? [] : [goal]
    }
    const restored = { ...rollbackValue(goal, original, failed) as Goal }
    // Never detach adopted proposals from tasks that have already started or changed.
    if (retainedTasks.size && goal.assistant?.proposals) {
      const retained = goal.assistant.proposals.filter(item => item.taskId && retainedTasks.has(item.taskId))
      if (retained.length) restored.assistant = { ...restored.assistant, proposals: [...(restored.assistant?.proposals ?? []).filter(item => !retained.some(kept => kept.id === item.id)), ...retained] }
    }
    return [restored]
  })
  for (const goal of before.goals) if (!failedGoals.has(goal.id) && !current.goals.some(item => item.id === goal.id)) goals.push(goal)
  const activeGoalId = current.activeGoalId === applied.activeGoalId && before.activeGoalId !== applied.activeGoalId ? before.activeGoalId : current.activeGoalId
  const activeTaskId = current.activeTaskId === applied.activeTaskId && before.activeTaskId !== applied.activeTaskId ? before.activeTaskId : current.activeTaskId
  const goalExplorationInput = current.goalExplorationInput === applied.goalExplorationInput && before.goalExplorationInput !== applied.goalExplorationInput ? before.goalExplorationInput : current.goalExplorationInput
  if (same(goals, current.goals) && tasks.length === current.tasks.length && activeGoalId === current.activeGoalId && activeTaskId === current.activeTaskId && goalExplorationInput === current.goalExplorationInput) return current
  return { ...current, goals, tasks, activeGoalId, activeTaskId, goalExplorationInput }
}
