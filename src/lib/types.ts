import type { Artifact } from './artifacts'
import type { Goal } from './goal-types'
import type { AgentProfile } from './agent-types'
import type { ExecutionStep, RunContext, TaskBusinessStatus, TaskResult } from './task-types'
export type Adapter = 'codex' | 'claude' | 'generic' | 'kimi' | 'pi'
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export type ReasoningEffort = 'inherit' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface CodexRuntimePermissions {
  sandbox: 'inherit' | 'read-only' | 'workspace-write' | 'danger-full-access'
  network: 'inherit' | 'deny' | 'allow'
  additionalDirectories: string[]
}
export interface ClaudeRuntimePermissions {
  mode: 'inherit' | 'manual' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
  additionalDirectories: string[]
  allowedTools: string[]
  disallowedTools: string[]
}
export interface RuntimePermissions {
  codex?: CodexRuntimePermissions
  claude?: ClaudeRuntimePermissions
  generic?: { args: string[] }
  kimi?: { mode: 'auto' | 'manual' }
}
export interface RuntimeConfig {
  id: string; name: string; executable: string; adapter: Adapter; enabled: boolean
  args: string[]; defaultModel: string; description: string
  permissions?: RuntimePermissions
}
export interface ModelConfig {
  id: string; name: string; modelId: string; providerId: string; runtimeIds: string[]; enabled: boolean
  reasoningEffort?: ReasoningEffort
  supportedReasoningEfforts?: Exclude<ReasoningEffort, 'inherit'>[]
  supportedReasoningEffortsByRuntime?: Record<string, Exclude<ReasoningEffort, 'inherit'>[]>
}
export interface ProviderConfig {
  id: string; name: string; baseUrl: string; credentialEnv: string
}
export type ThemePreference = 'system' | 'dark' | 'light'
export interface Settings {
  runtimes: RuntimeConfig[]; models: ModelConfig[]; providers: ProviderConfig[]
  defaultRuntime: string; defaultMode: 'solo' | 'team'; maxParallel: number
  defaultDirectory: string
  /** UI font family; empty or absent uses the application default. */
  fontFamily?: string
  /** Manual UI language override; absent follows the current system language. */
  language?: 'zh' | 'en'
  /** Empty/legacy settings follow the operating system appearance. */
  theme?: ThemePreference
  /** Legacy persisted setting; ignored. Runtime output is retained without a quota. */
  outputLimit?: number
}
export interface Member { agentProfileId?: string; agentProfileVersion?: number; instructions?: string; id: string; name: string; role: string; runtimeId: string; modelId: string; reasoningEffort?: ReasoningEffort }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; memberId?: string; runId?: string; streaming?: boolean; kind?: 'message' | 'reasoning' }
export interface RunMember extends Member { runtime: RuntimeConfig; model: string; status: RunStatus; effectiveReasoningEffort?: ReasoningEffort; sessionId?: string }
export interface Run { context?: RunContext; stepId?: string; id: string; createdAt: string; prompt: string; members: RunMember[]; directory: string }
export interface Task {
  /** Internal goal conversations reuse the same durable Runtime protocol. */
  kind?: 'goal_assistant'
  deadline?: string
  delivery?: string
  requirementsVersion?: number
  /** Renderer-only: raw history has not been loaded/recovered yet. Never persisted. */
  historyPending?: boolean
  /** Explicitly saved document references; automatic entries derive from retained messages/trace. */
  artifacts?: Artifact[]
  goalId?: string; parentTaskId?: string; businessStatus?: TaskBusinessStatus; acceptance?: string
  priority?: 'low' | 'normal' | 'high'; dependencies?: string[]; results?: TaskResult[]
  executor?: 'agent' | 'human'; stageId?: string; plan?: ExecutionStep[]; orchestration?: 'running' | 'stopped' | 'completed'
  id: string; title: string; directory: string; mode: 'solo' | 'team'; members: Member[]
  messages: Message[]; runs: Run[]; events: RuntimeEvent[]; createdAt: string; demo?: boolean
}
export interface AppState { version: 1 | 2; goals: Goal[]; agents: AgentProfile[]; activeGoalId?: string; goalExplorationInput?: string; settings: Settings; tasks: Task[]; activeTaskId: string; onboarding?: OnboardingState }
export interface RuntimeEvent {
  id: string; taskId: string; runId: string; memberId: string; timestamp: string
  kind: 'started' | 'stdout' | 'stderr' | 'completed' | 'failed' | 'stopped'
  text: string; exitCode?: number | null
}
export interface ProbeResult { found: boolean; path: string; version: string; error?: string | null }
export interface DiscoveredModel { modelId: string; name: string; source: string; selected: boolean; aliases?: string[]; supportedReasoningEfforts?: Exclude<ReasoningEffort, 'inherit'>[] }
export interface DiscoveredRuntime {
  id: string; name: string; executable: string; adapter: Adapter; probe: ProbeResult
  models: DiscoveredModel[]; configSources: string[]; warnings: string[]
}
export interface LocalDiscoveryReport { scannedAt: string; runtimes: DiscoveredRuntime[] }
export interface OnboardingState {
  version: 1; completedAt: string; outcome: 'imported' | 'manual' | 'configured' | 'deferred'; lastScan?: LocalDiscoveryReport
  managedRuntimes?: RuntimeConfig[]
}
export interface StorageInfo { path: string; bytes: number }
export interface StartRequest {
  taskId: string; runId: string; memberId: string; runtime: RuntimeConfig
  model: string; directory: string; prompt: string
  reasoningEffort?: ReasoningEffort
  sessionId?: string
}
