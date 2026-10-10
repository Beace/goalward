import type { Goal } from './goal-types'
export type TaskBusinessStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'
export interface TaskResult {
  id: string; summary: string; evidence: string; createdAt: string; runId?: string
  /** The task requirements this result was submitted against; legacy records use 0. */
  requirementsVersion?: number
  verdict: 'submitted' | 'accepted' | 'rejected'; reviewedAt?: string; reviewNote?: string
  goalUpdateId?: string
}
export interface ExecutionStep {
  id: string; title: string; instructions: string; memberIds: string[]; dependsOn: string[]
  kind: 'agent' | 'human'; expectedOutput: string; failurePolicy: 'halt' | 'continue'
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'
  runId?: string; output?: string
}
export interface RunContext {
  goal?: Goal
  task: { title: string; acceptance: string; goalId?: string; parentTaskId?: string; businessStatus: TaskBusinessStatus; deadline?: string; delivery?: string; requirementsVersion?: number }
  step?: ExecutionStep
}
