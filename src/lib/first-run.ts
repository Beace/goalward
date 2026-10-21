import type { Goal, GoalAssistantDraft } from './goal-types'
import type { AppState, LocalDiscoveryReport, Task } from './types'
import type { TaskResult } from './task-types'
import { isBusinessTask } from './goal-progress'
import { canConfigureTask } from './onboarding'
import { translate } from '@/i18n'

/** Remember the goal created from the empty-workspace entry without a new persisted field. */
export const firstRunGoalKey = 'goalward.first-run.goal'

export const firstRunTemplates = [
  {
    id: 'feature',
    label: ['发布一个小功能', 'Ship a small feature'],
    prompt: ['两周内让新用户 10 分钟跑通首个任务', 'Get a new user through the first task in 10 minutes, within two weeks'],
  },
  {
    id: 'bug',
    label: ['修一个 bug 并补测试', 'Fix a bug and add tests'],
    prompt: ['修复移动端导航栏遮挡内容的问题，增加 e2e 覆盖', 'Fix the mobile navigation covering content, and add end-to-end coverage'],
  },
  {
    id: 'report',
    label: ['写本周周报', 'Write this week’s update'],
    prompt: ['汇总 Git commit 和会议记录，生成团队同步简报', 'Summarize Git commits and meeting notes into a team update'],
  },
  {
    id: 'health',
    label: ['体检这个代码库', 'Check this repository'],
    prompt: ['运行 linter 和类型检查，列出 Top 10 需要优化的文件', 'Run the linter and type check, then list the top 10 files to improve'],
  },
] as const

/** The single-screen clarification stays up only for the goal started from the empty entry. */
export function firstRunGoalId(state: Pick<AppState, 'goals'>, rememberedId: string | null): string | null {
  if (!rememberedId || state.goals.length !== 1) return null
  const goal = state.goals[0]
  if (goal.id !== rememberedId || goal.status !== 'clarifying' || goal.assistant?.confirmedVersion) return null
  return goal.id
}

/** Starter placeholders are not a chosen runtime. Imported, manual, or saved configuration is. */
export function runtimeReadyForExecution(state: Pick<AppState, 'onboarding' | 'settings'>): boolean {
  const outcome = state.onboarding?.outcome
  if (outcome !== 'imported' && outcome !== 'configured' && outcome !== 'manual') return false
  return state.settings.runtimes.some(canConfigureTask)
}

export function discoveredRuntimeNames(report: LocalDiscoveryReport | null | undefined): string[] {
  return (report?.runtimes ?? [])
    .filter(runtime => runtime.probe.found && !runtime.probe.error && runtime.adapter !== 'generic')
    .map(runtime => runtime.name)
}

/** A one-line criterion is enough on the first-run card; verification details can be filled in later. */
export function prepareFirstRunDraft(draft: GoalAssistantDraft): GoalAssistantDraft {
  const criteria = draft.criteria.filter(item => item.text.trim()).map(item => ({
    text: item.text.trim(),
    baseline: item.baseline.trim(),
    target: item.target.trim() || item.text.trim(),
    method: item.method.trim() || translate('在目标卡片上核对这项结果', 'Check this result on the goal card'),
  }))
  return {
    ...draft,
    title: draft.title.trim(),
    intent: draft.intent.trim(),
    expected: draft.expected.trim(),
    constraints: draft.constraints.trim(),
    currentSummary: draft.currentSummary.trim(),
    criteria,
  }
}

/** The first submitted result on a goal, before any result has been accepted. */
export function firstPendingAcceptance(state: Pick<AppState, 'tasks'>, goalId: string): { task: Task; result: TaskResult } | undefined {
  const tasks = state.tasks.filter(task => task.goalId === goalId && isBusinessTask(task))
  if (tasks.some(task => task.results?.some(result => result.verdict === 'accepted'))) return undefined
  for (const task of tasks) {
    const result = task.results?.at(-1)
    if (result?.verdict === 'submitted') return { task, result }
  }
  return undefined
}

export function acceptanceItems(task: Task, goal: Goal): string[] {
  const lines = (task.acceptance ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const criteria = goal.criteria.map(item => item.text.trim()).filter(Boolean)
  if (criteria.length) return criteria
  if (lines.length === 1) return lines
  return [translate('结果符合当前任务的验收要求', 'The result meets this task’s acceptance criteria')]
}
