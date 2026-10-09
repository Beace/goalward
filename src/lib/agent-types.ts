import type { ReasoningEffort } from './types'

/** Reusable intent and execution defaults; a profile is never a running process. */
export interface AgentProfileConfig {
  name: string
  role: string
  instructions: string
  description: string
  runtimeId: string
  modelId: string
  reasoningEffort?: ReasoningEffort
}

export interface AgentProfileRevision {
  version: number
  createdAt: string
  summary: string
  snapshot: AgentProfileConfig
}

export interface AgentProfile extends AgentProfileConfig {
  id: string
  version: number
  enabled: boolean
  assignedGoalIds: string[]
  createdAt: string
  updatedAt: string
  history: AgentProfileRevision[]
}
