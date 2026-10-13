import type { AppState, Task } from './types'
import type { Goal } from './goal-types'
import { translate } from '@/i18n'

// Do not resolve .. or symlinks: those operations can change a path's meaning.
export function normalizeWorkingDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((path): path is string => typeof path === 'string').map(path => path.trim().replace(/\/+$/, '') || (path.trim().startsWith('/') ? '/' : '')).filter(Boolean))]
}
const taskRoots = (task: Task) => normalizeWorkingDirectories([task.directory, ...normalizeWorkingDirectories(task.workingDirectories)])
const sameRoots = (left: unknown, right: string[]) => Array.isArray(left) && left.length === right.length && left.every((path, index) => path === right[index])
const isRunning = (task: Task) => task.orchestration === 'running' || task.runs.some(run => run.members.some(member => member.status === 'running'))

/** Legacy roots are retained in order, including every linked project's directory. */
export function getGoalWorkingDirectories(state: AppState, goal: Goal): string[] {
  const explicit = normalizeWorkingDirectories(goal.workingDirectories)
  if (explicit.length) return explicit
  const linked = state.tasks.filter(task => !task.demo && task.goalId === goal.id)
  const business = linked.filter(task => task.kind !== 'goal_assistant')
  return normalizeWorkingDirectories((business.length ? business : linked).flatMap(taskRoots))
}

export function getTaskWorkingDirectories(state: AppState, task: Task): string[] {
  const goal = state.goals.find(goal => goal.id === task.goalId)
  const inherited = goal ? getGoalWorkingDirectories(state, goal) : []
  if (inherited.length) return inherited
  const own = taskRoots(task)
  if (own.length) return own
  const parent = state.tasks.find(parent => parent.id === task.parentTaskId)
  if (parent && parent.id !== task.id) {
    // Follow only already stored parent roots; malformed cycles must not recurse.
    const parentGoal = state.goals.find(goal => goal.id === parent.goalId)
    const roots = parentGoal ? getGoalWorkingDirectories(state, parentGoal) : taskRoots(parent)
    if (roots.length) return roots
  }
  return normalizeWorkingDirectories([state.settings.defaultDirectory])
}

export function inheritTaskWorkingDirectories(state: AppState, task: Task): Task {
  const roots = getTaskWorkingDirectories(state, task)
  if (!roots.length || isRunning(task) || (task.directory === roots[0] && sameRoots(task.workingDirectories, roots))) return task
  return { ...task, directory: roots[0], workingDirectories: roots, ...(task.directory && task.directory !== roots[0] && !task.legacyArtifactDirectory ? { legacyArtifactDirectory: task.directory } : {}) }
}

/** Edit future workspaces only. Existing turns and active task projections retain their roots. */
export function applyGoalWorkingDirectories(state: AppState, goalId: string, paths: string[]): AppState {
  const goal = state.goals.find(goal => goal.id === goalId)
  if (!goal) throw new Error(translate('目标不存在', 'Goal does not exist'))
  const roots = normalizeWorkingDirectories(paths)
  if (!roots.length) throw new Error(translate('目标需要保留一个主工作目录。', 'Keep one primary working directory for this goal.'))
  if (roots.some(path => !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) throw new Error(translate('请输入完整的绝对目录路径。', 'Enter a full absolute directory path.'))
  const next = sameRoots(goal.workingDirectories, roots) ? state : { ...state, goals: state.goals.map(item => item.id === goalId ? { ...item, workingDirectories: roots, updatedAt: new Date().toISOString() } : item) }
  const tasks = next.tasks.map(task => task.goalId === goalId ? inheritTaskWorkingDirectories(next, task) : task)
  return tasks.some((task, index) => task !== next.tasks[index]) ? { ...next, tasks } : next
}

/** Additive and idempotent: migration never rewrites historical Run roots or native identities. */
export function migrateWorkingDirectories(state: AppState): AppState {
  const goals = state.goals.map(goal => {
    const roots = getGoalWorkingDirectories(state, goal)
    return roots.length && !sameRoots(goal.workingDirectories, roots) ? { ...goal, workingDirectories: roots } : goal
  })
  const withGoals = goals.some((goal, index) => goal !== state.goals[index]) ? { ...state, goals } : state
  const tasks = withGoals.tasks.map(task => task.demo ? task : inheritTaskWorkingDirectories(withGoals, task))
  return tasks.some((task, index) => task !== withGoals.tasks[index]) ? { ...withGoals, tasks } : withGoals
}
