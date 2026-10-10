/** Goal records are independent of Runtime configuration and execution state. */
export type GoalStatus = 'clarifying' | 'active' | 'paused' | 'achieved' | 'maintenance' | 'ended'
export type GoalEntryKind = 'fact' | 'artifact' | 'decision' | 'hypothesis' | 'unknown' | 'blocker' | 'metric'
export interface GoalSource {
  kind: 'user' | 'task' | 'file' | 'url' | 'tool'
  label: string
  reference?: string
  taskId?: string
  runId?: string
}
export interface GoalStateEntry {
  id: string
  kind: GoalEntryKind
  text: string
  source: GoalSource
  createdAt: string
  /** Optional observation. Text remains sufficient for non-numeric goals. */
  metric?: { name: string; value: number; unit: string; observedAt: string; definition: string }
}
export interface GoalStateSnapshot {
  version: number
  summary: string
  entries: GoalStateEntry[]
  createdAt: string
  reason: string
  source: GoalSource
  eventKey?: string
}
export interface GoalCriterion {
  id: string
  text: string
  status: 'unverified' | 'satisfied' | 'unsatisfied'
  evidence: string
  checkedAt?: string
  baseline?: string
  target?: string
  method?: string
}
export interface GoalAssistantDraft {
  title: string
  intent: string
  expected: string
  constraints: string
  deadline: string
  currentSummary: string
  criteria: Array<{ text: string; baseline: string; target: string; method: string }>
}
export interface GoalTaskProposal {
  id: string
  title: string
  delivery: string
  acceptance: string
  deadline: string
  dependsOn: string[]
  status: 'suggested' | 'adopted' | 'dismissed'
  taskId?: string
  baseGoalVersion: number
  /** User-owned content survives a later planning reply. Never accepted from model JSON. */
  edited?: boolean
}
export interface GoalAssistantState {
  taskId?: string
  draft?: GoalAssistantDraft
  /** Kept after invalidation so a captured old draft cannot be confirmed again. */
  draftGoalVersion?: number
  draftStateVersion?: number
  proposals?: GoalTaskProposal[]
  confirmedVersion?: number
  input?: string
  requestPhase?: 'clarify' | 'plan'
  processedRunId?: string
  /** A completed reply can be readable even when its structured proposal is invalid. */
  error?: string
}
export interface GoalDefinition {
  version: number
  title: string
  intent: string
  expected: string
  constraints: string
  deadline: string
  criteria: GoalCriterion[]
  createdAt: string
  reason: string
}
export interface GoalStateProposal {
  id: string
  title: string
  baseStateVersion: number
  entries: GoalStateEntry[]
  source: GoalSource
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  resolvedAt?: string
  eventKey?: string
}
export interface GoalPlanStage {
  id: string
  title: string
  description: string
  status: 'planned' | 'active' | 'done' | 'blocked'
}
export interface GoalReviewSchedule {
  enabled: boolean
  weekday: number
  hour: number
  timeZone: string
  startedAt: string
}
export interface GoalReview {
  id: string
  createdAt: string
  trigger: 'manual' | 'weekly'
  periodKey?: string
  scheduledFor?: string
  judgement: 'on_track' | 'at_risk' | 'off_track' | 'unknown'
  summary: string
  evidence: string
  nextActions: string[]
  definition: GoalDefinition
  beforeState: GoalStateSnapshot
  afterState: GoalStateSnapshot
  /** Weekly snapshots await human assessment; no model call is implied. */
  needsAssessment: boolean
}
export interface Goal {
  id: string
  title: string
  intent: string
  expected: string
  constraints: string
  deadline: string
  status: GoalStatus
  version: number
  criteria: GoalCriterion[]
  definitions: GoalDefinition[]
  currentState: GoalStateSnapshot
  stateHistory: GoalStateSnapshot[]
  proposals: GoalStateProposal[]
  plan: GoalPlanStage[]
  reviews: GoalReview[]
  reviewSchedule?: GoalReviewSchedule
  createdAt: string
  updatedAt: string
  /** Additive metadata; conversation history remains in the assistant Task. */
  assistant?: GoalAssistantState
}
