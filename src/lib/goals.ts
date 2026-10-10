import type { Goal, GoalCriterion, GoalDefinition, GoalEntryKind, GoalReview, GoalReviewSchedule, GoalSource, GoalStateEntry, GoalStateProposal, GoalStateSnapshot, GoalStatus } from './goal-types'
export type * from './goal-types'
import { translate } from '@/i18n'

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const copy = <T,>(value: T): T => structuredClone(value)
const userSource = (): GoalSource => ({ kind: 'user', label: translate('用户提供', 'User provided') })
const iso = () => new Date().toISOString()
export type GoalCriterionInput = string | { text: string; baseline?: string; target?: string; method?: string }
const criterionDefinition = (value: GoalCriterionInput) => typeof value === 'string' ? { text: value.trim() } : { text: value.text.trim(), baseline: value.baseline?.trim(), target: value.target?.trim(), method: value.method?.trim() }
const sameCriterionDefinition = (left: ReturnType<typeof criterionDefinition>, right: GoalCriterion) => left.text === right.text && (left.baseline ?? '') === (right.baseline ?? '') && (left.target ?? '') === (right.target ?? '') && (left.method ?? '') === (right.method ?? '')
const invalidateAssistantDraft = (goal: Goal) => goal.assistant ? { ...goal.assistant, draft: undefined, draftGoalVersion: goal.assistant.draftGoalVersion ?? goal.version, draftStateVersion: goal.assistant.draftStateVersion ?? goal.currentState.version } : undefined
export const goalStatusLabels: Record<GoalStatus, string> = { clarifying: '待澄清', active: '推进中', paused: '已暂停', achieved: '已达成', maintenance: '维护中', ended: '已结束' }
export const goalEntryLabels: Record<GoalEntryKind, string> = { fact: '已知事实', artifact: '已有成果', decision: '已作决定', hypothesis: '待验证假设', unknown: '未知问题', blocker: '当前障碍', metric: '指标观测' }
export const reviewJudgementLabels: Record<GoalReview['judgement'], string> = { on_track: '符合预期', at_risk: '存在风险', off_track: '偏离预期', unknown: '暂无法判断' }

export function goalDefinition(goal: Goal, reason = translate('目标快照', 'Goal snapshot')): GoalDefinition {
  return copy({ version: goal.version, title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, criteria: goal.criteria, createdAt: goal.updatedAt, reason })
}

export function createGoal(input: { title: string; intent?: string; expected?: string; constraints?: string; deadline?: string; criteria?: GoalCriterionInput[]; currentSummary?: string }, now = iso()): Goal {
  if (!input.title.trim()) throw new Error(translate('请先描述想推进的目标。', 'Describe the goal you want to pursue first.'))
  const currentState: GoalStateSnapshot = { version: 1, summary: input.currentSummary?.trim() ?? '', entries: [], createdAt: now, reason: translate('建立初始现状', 'Established initial context'), source: copy(userSource()) }
  const goal: Goal = {
    id: id('goal'), title: input.title.trim(), intent: input.intent?.trim() ?? '', expected: input.expected?.trim() ?? '', constraints: input.constraints?.trim() ?? '', deadline: input.deadline ?? '',
    version: 1, status: input.expected?.trim() ? 'active' : 'clarifying', criteria: (input.criteria ?? []).map(criterionDefinition).filter(item => item.text).map(item => ({ id: id('criterion'), ...item, status: 'unverified', evidence: '' })),
    definitions: [], currentState, stateHistory: [copy(currentState)], proposals: [], plan: [], reviews: [], createdAt: now, updatedAt: now,
  }
  goal.definitions.push(goalDefinition(goal, translate('创建目标', 'Created goal')))
  return goal
}

export function reviseGoal(goal: Goal, input: { title: string; intent: string; expected: string; constraints: string; deadline: string; criteria: GoalCriterionInput[]; reason: string }, now = iso()): Goal {
  if (!input.title.trim()) throw new Error(translate('目标名称不能为空。', 'Goal name cannot be empty.'))
  if (!input.reason.trim()) throw new Error(translate('请记录本次修订的原因。', 'Record why this goal is being revised.'))
  // Expected-outcome changes invalidate all assessments. Old definitions retain evidence.
  const outcomeChanged = goal.expected !== input.expected.trim()
  const remaining = [...goal.criteria]
  const criteria = input.criteria.map(criterionDefinition).filter(item => item.text).map(item => {
    const index = remaining.findIndex(criterion => sameCriterionDefinition(item, criterion))
    if (index < 0) return { id: id('criterion'), ...item, status: 'unverified' as const, evidence: '' }
    const previous = copy(remaining.splice(index, 1)[0])
    return outcomeChanged ? { ...previous, status: 'unverified' as const, evidence: '', checkedAt: undefined } : previous
  })
  const next: Goal = { ...goal, title: input.title.trim(), intent: input.intent.trim(), expected: input.expected.trim(), constraints: input.constraints.trim(), deadline: input.deadline, criteria, version: goal.version + 1, updatedAt: now, assistant: invalidateAssistantDraft(goal) }
  if (next.status === 'achieved' && (!criteria.length || criteria.some(criterion => criterion.status !== 'satisfied'))) next.status = 'active'
  // Archive the most recent assessment under its old definition before clearing it.
  const archived = goal.definitions.map(definition => definition.version === goal.version ? { ...definition, criteria: copy(goal.criteria) } : definition)
  return { ...next, definitions: [...archived, goalDefinition(next, input.reason.trim())] }
}

export function createStateEntry(kind: GoalEntryKind, text: string, source: GoalSource = userSource(), now = iso()): GoalStateEntry {
  if (!text.trim()) throw new Error(translate('请填写现状内容。', 'Enter context details.'))
  if (!source.label.trim()) throw new Error(translate('请填写来源。', 'Enter a source.'))
  return { id: id('state-entry'), kind, text: text.trim(), source: copy(source), createdAt: now }
}

export function updateGoalState(goal: Goal, input: { summary?: string; entries?: GoalStateEntry[]; appendEntries?: GoalStateEntry[]; reason: string; source?: GoalSource; eventKey?: string; baseStateVersion?: number }, now = iso()): Goal {
  if (input.eventKey && goal.stateHistory.some(snapshot => snapshot.eventKey === input.eventKey)) return goal
  if (input.baseStateVersion !== undefined && input.baseStateVersion !== goal.currentState.version) throw new Error(translate('现状已更新，请重新核对最新版本后保存。', 'Context has changed. Review the latest version before saving.'))
  if (!input.reason.trim()) throw new Error(translate('请记录本次变化的原因。', 'Record why this change was made.'))
  const entries = copy(input.entries ?? goal.currentState.entries)
  for (const entry of input.appendEntries ?? []) if (!entries.some(existing => existing.id === entry.id)) entries.push(copy(entry))
  const snapshot: GoalStateSnapshot = { version: goal.currentState.version + 1, summary: input.summary === undefined ? goal.currentState.summary : input.summary.trim(), entries, createdAt: now, reason: input.reason.trim(), source: copy(input.source ?? userSource()), eventKey: input.eventKey }
  const assistant = snapshot.summary !== goal.currentState.summary ? invalidateAssistantDraft(goal) : goal.assistant?.draft ? { ...goal.assistant, draftStateVersion: snapshot.version } : goal.assistant
  return { ...goal, currentState: snapshot, stateHistory: [...goal.stateHistory, copy(snapshot)], updatedAt: now, assistant }
}

export function proposeGoalState(goal: Goal, input: { title: string; entries: GoalStateEntry[]; source: GoalSource; eventKey?: string }, now = iso()): Goal {
  if (input.eventKey && (goal.proposals.some(proposal => proposal.eventKey === input.eventKey) || goal.stateHistory.some(snapshot => snapshot.eventKey === input.eventKey))) return goal
  if (!input.title.trim() || !input.entries.length) throw new Error(translate('变化建议需要内容和依据。', 'A change proposal needs content and evidence.'))
  const proposal: GoalStateProposal = { id: id('proposal'), title: input.title.trim(), entries: copy(input.entries), source: copy(input.source), baseStateVersion: goal.currentState.version, createdAt: now, status: 'pending', eventKey: input.eventKey }
  return { ...goal, proposals: [...goal.proposals, proposal], updatedAt: now }
}

export function acceptGoalProposal(goal: Goal, proposalId: string, now = iso()): Goal {
  const proposal = goal.proposals.find(item => item.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return goal
  if (proposal.baseStateVersion !== goal.currentState.version) throw new Error(translate('建议基于旧版现状。请先核对变化并重新确认依据。', 'This proposal is based on older context. Review the changes and confirm the evidence again.'))
  const next = updateGoalState(goal, { appendEntries: proposal.entries, reason: translate(`采纳变化：${proposal.title}`, `Accepted change: ${proposal.title}`), source: proposal.source, eventKey: proposal.eventKey ?? `proposal:${proposal.id}`, baseStateVersion: proposal.baseStateVersion }, now)
  return { ...next, proposals: next.proposals.map(item => item.id === proposalId ? { ...item, status: 'accepted', resolvedAt: now } : item) }
}

export function rebaseGoalProposal(goal: Goal, proposalId: string, now = iso()): Goal {
  // Explicit user reconciliation retains the superseded suggestion and creates a fresh one.
  const proposal = goal.proposals.find(item => item.id === proposalId && item.status === 'pending')
  if (!proposal || proposal.baseStateVersion === goal.currentState.version) return goal
  return { ...goal, updatedAt: now, proposals: [...goal.proposals.map(item => item.id === proposalId ? { ...item, status: 'rejected' as const, resolvedAt: now } : item), { ...copy(proposal), id: id('proposal'), baseStateVersion: goal.currentState.version, createdAt: now, eventKey: proposal.eventKey, status: 'pending', resolvedAt: undefined }] }
}

export function updateCriterion(goal: Goal, criterionId: string, status: GoalCriterion['status'], evidence: string, now = iso()): Goal {
  if (status !== 'unverified' && !evidence.trim()) throw new Error(translate('请填写验收依据后确认成功条件。', 'Enter acceptance evidence before confirming the success criterion.'))
  const criteria = goal.criteria.map(criterion => criterion.id === criterionId ? { ...criterion, status, evidence: evidence.trim(), checkedAt: now } : criterion)
  return { ...goal, criteria, status: goal.status === 'achieved' && criteria.some(criterion => criterion.status !== 'satisfied') ? 'active' : goal.status, updatedAt: now }
}

export function setGoalStatus(goal: Goal, status: GoalStatus, now = iso()): Goal {
  if (status === 'achieved' && (!goal.criteria.length || goal.criteria.some(criterion => criterion.status !== 'satisfied' || !criterion.evidence))) throw new Error(translate('请先逐项确认成功条件并记录依据，再确认目标达成。', 'Confirm each success criterion and record its evidence before marking the goal achieved.'))
  return { ...goal, status, updatedAt: now }
}

export function saveGoalReview(goal: Goal, input: { judgement: GoalReview['judgement']; summary: string; evidence: string; nextActions: string[] }, now = iso()): Goal {
  if (!input.summary.trim()) throw new Error(translate('请填写复盘结论。', 'Enter a review conclusion.'))
  if (input.judgement !== 'unknown' && !input.evidence.trim()) throw new Error(translate('进度判断需要对应的预期标准与依据。', 'A progress judgement needs an expected standard and supporting evidence.'))
  const previous = goal.reviews.at(-1)
  const review: GoalReview = { id: id('review'), createdAt: now, trigger: 'manual', judgement: input.judgement, summary: input.summary.trim(), evidence: input.evidence.trim(), nextActions: input.nextActions.map(action => action.trim()).filter(Boolean), definition: goalDefinition(goal), beforeState: copy(previous?.afterState ?? goal.stateHistory[0]), afterState: copy(goal.currentState), needsAssessment: false }
  return { ...goal, reviews: [...goal.reviews, review], updatedAt: now }
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') }
}

function localHourToInstant(date: Date, hour: number, timeZone: string): string {
  const desired = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour)
  const civil = (instant: number) => { const local = zonedParts(new Date(instant), timeZone); return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) }
  // Collect offsets on both sides of a possible DST transition. Repeated local
  // hours choose the earlier instant; a skipped hour moves forward by the gap.
  // Including minutes also handles UTC offsets such as Asia/Kathmandu (+05:45).
  const offsets = new Set([-86400000, 0, 86400000].map(delta => civil(desired + delta) - (desired + delta)))
  const candidates = [...offsets].map(offset => desired - offset).sort((a, b) => a - b)
  const exact = candidates.find(candidate => civil(candidate) === desired)
  const afterGap = candidates.filter(candidate => civil(candidate) > desired).sort((a, b) => civil(a) - civil(b))[0]
  return new Date(exact ?? afterGap ?? candidates[0]).toISOString()
}

export function validateReviewSchedule(schedule: GoalReviewSchedule) {
  if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6 || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 || Number.isNaN(Date.parse(schedule.startedAt))) throw new Error(translate('复盘周期设置无效。', 'Invalid review schedule.'))
  try { new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format() } catch { throw new Error(translate('请选择有效的复盘时区。', 'Select a valid review time zone.')) }
}

/** Return only the latest missed weekly slot; opening after a long absence never creates a backlog storm. */
export function dueReviewPeriod(goal: Goal, now = iso()): { key: string; scheduledFor: string } | null {
  const schedule = goal.reviewSchedule
  if (!schedule?.enabled || ['paused', 'achieved', 'ended'].includes(goal.status)) return null
  try { validateReviewSchedule(schedule) } catch { return null }
  const local = zonedParts(new Date(now), schedule.timeZone)
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  let delta = (day.getUTCDay() - schedule.weekday + 7) % 7
  if (!delta && local.hour < schedule.hour) delta = 7
  day.setUTCDate(day.getUTCDate() - delta)
  const key = `${schedule.timeZone}:${day.toISOString().slice(0, 10)}:${String(schedule.hour).padStart(2, '0')}`
  const scheduledFor = localHourToInstant(day, schedule.hour, schedule.timeZone)
  if (Date.parse(scheduledFor) < Date.parse(schedule.startedAt) || Date.parse(scheduledFor) > Date.parse(now) || goal.reviews.some(review => review.periodKey === key)) return null
  return { key, scheduledFor }
}

export function createDueGoalReview(goal: Goal, now = iso()): Goal {
  const period = dueReviewPeriod(goal, now)
  if (!period) return goal
  const beforeState = goal.reviews.at(-1)?.afterState ?? goal.stateHistory[0]
  const satisfied = goal.criteria.filter(criterion => criterion.status === 'satisfied').length
  const changes = goal.stateHistory.filter(snapshot => snapshot.version > beforeState.version).length
  const review: GoalReview = {
    id: id('review'), createdAt: now, trigger: 'weekly', periodKey: period.key, scheduledFor: period.scheduledFor, judgement: 'unknown',
    summary: translate(`已记录本期现状快照：较上次复盘有 ${changes} 次现状修订，${satisfied}/${goal.criteria.length} 项成功条件已确认。是否符合预期仍需结合证据判断。`, `Context snapshot recorded for this period: ${changes} context revisions since the last review, with ${satisfied}/${goal.criteria.length} success criteria confirmed. Whether progress meets expectations still requires evidence.`),
    evidence: translate('根据应用内保存的目标、现状与验收记录整理；未查询外部数据或调用模型。', 'Compiled from goals, context, and acceptance records saved in the app; no external data was queried and no model was called.'), nextActions: [], definition: goalDefinition(goal), beforeState: copy(beforeState), afterState: copy(goal.currentState), needsAssessment: true,
  }
  return { ...goal, reviews: [...goal.reviews, review], updatedAt: now }
}
