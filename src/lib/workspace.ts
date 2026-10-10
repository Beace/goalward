import type { AppState, Task, Member, Run, Settings } from './types'
import type { ExecutionStep, RunContext, TaskBusinessStatus, TaskResult } from './task-types'
import { migrateTraexRuntime } from './traex-runtime'
import { translate } from '@/i18n'
import { isAcceptedTaskDone } from './goal-progress'

export const taskStatusLabels: Record<TaskBusinessStatus, string> = { todo: '待开始', in_progress: '进行中', blocked: '受阻', review: '待验收', done: '已完成', cancelled: '已取消' }
const id = () => crypto.randomUUID()
const now = () => new Date().toISOString()
export const isTaskRunning = (task: Task) => task.runs.some(run => run.members.some(member => member.status === 'running'))

export interface TaskEditValues {
  title: string
  acceptance: string
  directory: string
  goalId?: string
  priority: Task['priority']
  stageId?: string
  dependencies: string[]
  deadline?: string
  delivery?: string
}

/** An orchestration can still dispatch while no process is currently running. */
export function taskMutationLockReason(task: Task): string {
  return isTaskRunning(task) || task.orchestration === 'running' ? translate('请先停止执行和编排，再编辑或删除', 'Stop the run and orchestration before editing or deleting.') : ''
}

export function getTaskDeletionBlockers(state: AppState, taskId: string): { children: Task[]; dependents: Task[]; reason: string } {
  const task = state.tasks.find(item => item.id === taskId)
  return {
    children: state.tasks.filter(item => item.parentTaskId === taskId),
    dependents: state.tasks.filter(item => item.id !== taskId && item.dependencies?.includes(taskId)),
    reason: task ? taskMutationLockReason(task) : translate('任务不存在或已删除', 'Task does not exist or was deleted'),
  }
}

/** Edit only mutable planning fields; historical execution and goal evidence are immutable. */
export function editWorkspaceTask(state: AppState, taskId: string, values: TaskEditValues): AppState {
  const task = state.tasks.find(item => item.id === taskId)
  if (!task) throw new Error(translate('任务不存在或已删除', 'Task does not exist or was deleted'))
  const lock = taskMutationLockReason(task)
  if (lock) throw new Error(lock)
  const title = values.title.trim(), goalId = values.goalId || undefined, stageId = values.stageId || undefined
  if (!title) throw new Error(translate('请输入任务名称', 'Enter a task name'))
  if (values.priority && !['low', 'normal', 'high'].includes(values.priority)) throw new Error(translate('任务优先级无效', 'Invalid task priority'))
  const goal = state.goals.find(item => item.id === goalId)
  if (goalId && !goal) throw new Error(translate('目标不存在', 'Goal does not exist'))
  if (task.parentTaskId) {
    const parent = state.tasks.find(item => item.id === task.parentTaskId)
    if (!parent) throw new Error(translate('父任务不存在，请先处理任务归属', 'Parent task does not exist. Resolve task ownership first.'))
    if (goalId !== parent.goalId) throw new Error(translate('子任务继承父任务目标，请修改父任务', 'Subtasks inherit their parent’s goal. Edit the parent task instead.'))
  }
  if (stageId && !goal?.plan.some(stage => stage.id === stageId)) throw new Error(translate('推进阶段不属于当前目标，请重新选择', 'The plan stage does not belong to this goal. Select another stage.'))
  const deadline = values.deadline === undefined ? task.deadline ?? '' : values.deadline.trim()
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(Date.parse(`${deadline}T00:00:00Z`)) || new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline)) throw new Error(translate('任务截止日期无效', 'Invalid task deadline'))
  if (deadline && goal?.deadline && deadline > goal.deadline) throw new Error(translate('任务日期晚于目标 DDL，请调整排期或先修订目标。', 'The task deadline is later than the goal deadline. Adjust the plan or revise the goal first.'))
  const delivery = values.delivery === undefined ? task.delivery ?? '' : values.delivery.trim()
  const requirementsChanged = (task.acceptance ?? '').trim() !== values.acceptance.trim() || (task.delivery ?? '') !== delivery
  let next = state
  if (task.goalId !== goalId) next = linkTaskToGoal(next, taskId, goalId)
  next = setTaskDependencies(next, taskId, values.dependencies)
  if (deadline && next.tasks.some(item => values.dependencies.includes(item.id) && item.deadline && item.deadline > deadline)) throw new Error(translate('任务截止日期早于前置任务，请调整排期。', 'The deadline precedes a dependency. Adjust the schedule.'))
  if (deadline && next.tasks.some(item => item.dependencies?.includes(taskId) && item.deadline && item.deadline < deadline)) throw new Error(translate('任务截止日期晚于后续任务，请调整依赖排期。', 'The deadline is later than a dependent task. Adjust the schedule.'))
  return { ...next, tasks: next.tasks.map(item => item.id === taskId ? { ...item, title, acceptance: values.acceptance.trim(), delivery, deadline, directory: values.directory.trim(), goalId, priority: values.priority, stageId, ...(requirementsChanged ? { requirementsVersion: (item.requirementsVersion ?? 0) + 1, businessStatus: item.businessStatus === 'done' ? 'review' as const : item.businessStatus } : {}) } : item) }
}

/** Remove one stopped task, never cascade through children, dependencies or goal evidence. */
export function deleteWorkspaceTask(state: AppState, taskId: string): AppState {
  const { children, dependents, reason } = getTaskDeletionBlockers(state, taskId)
  if (reason) throw new Error(reason)
  if (children.length) throw new Error(translate(`请先处理子任务：${children.map(task => task.title).join('、')}`, `Resolve subtasks first: ${children.map(task => task.title).join(', ')}`))
  if (dependents.length) throw new Error(translate(`以下任务仍依赖此任务，请先调整依赖：${dependents.map(task => task.title).join('、')}`, `These tasks still depend on this task. Adjust their dependencies first: ${dependents.map(task => task.title).join(', ')}`))
  const tasks = state.tasks.filter(task => task.id !== taskId)
  return { ...state, tasks, activeTaskId: state.activeTaskId === taskId ? tasks.find(item => item.kind !== 'goal_assistant')?.id ?? '' : state.activeTaskId }
}

/** Additive migration. Never interpret a process exit as business acceptance. */
export function migrateWorkspace(value: unknown): AppState {
  let raw = value as AppState
  if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.tasks) || !raw.settings || !Array.isArray(raw.settings.runtimes) || !Array.isArray(raw.settings.models)) throw new Error(translate('存储文件格式不兼容，原文件已保留。', 'Incompatible storage file format. The original file was preserved.'))
  if (raw.version === 2 && (!Array.isArray(raw.goals) || !Array.isArray(raw.agents))) throw new Error(translate('目标或 Agent 数据格式无效，原文件已保留。', 'Invalid goal or Agent data format. The original file was preserved.'))
  const runtimes = raw.settings.runtimes.map(migrateTraexRuntime)
  const managedRuntimes = raw.onboarding?.managedRuntimes?.map(migrateTraexRuntime)
  if (runtimes.some((runtime, index) => runtime !== raw.settings.runtimes[index])
    || managedRuntimes?.some((runtime, index) => runtime !== raw.onboarding?.managedRuntimes?.[index])) {
    raw = { ...raw, settings: { ...raw.settings, runtimes }, onboarding: raw.onboarding ? { ...raw.onboarding, managedRuntimes } : undefined }
  }
  if (raw.version === 2 && raw.settings.runtimes.some(runtime => runtime.id === 'kimi') && !raw.tasks.some(task => task.orchestration === 'running')) return raw
  const kimi = { id: 'kimi', name: 'Kimi CLI', executable: 'kimi', adapter: 'kimi' as const, enabled: false, args: [], defaultModel: '', description: translate('通过 ACP 执行，默认自动批准工具请求；模型与思考设置继承 Runtime。', 'Runs through ACP and auto-approves tool requests by default; model and reasoning settings inherit from the runtime.') }
  return { ...raw, version: 2, goals: raw.goals ?? [], agents: raw.agents ?? [], settings: { ...raw.settings, runtimes: raw.settings.runtimes.some(r => r.id === 'kimi') ? raw.settings.runtimes : [...raw.settings.runtimes, kimi] }, tasks: raw.tasks.map(task => task.orchestration === 'running' ? { ...task, orchestration: 'stopped' } : task) }
}

export function createWorkspaceTask(settings: Settings, input: { title: string; directory?: string; mode?: 'solo' | 'team'; goalId?: string; parentTaskId?: string; acceptance?: string; executor?: 'human' | 'agent'; members?: Member[] }): Task {
  if (!input.title.trim()) throw new Error(translate('请输入任务名称', 'Enter a task name'))
  const runtime = settings.runtimes.find(r => r.enabled && r.id === settings.defaultRuntime) ?? settings.runtimes.find(r => r.enabled)
  const members = input.members ?? (input.executor !== 'human' && runtime ? [{ id: id(), name: runtime.name, role: translate('执行', 'Execution'), runtimeId: runtime.id, modelId: runtime.defaultModel }] : [])
  return { id: id(), title: input.title.trim(), directory: input.directory?.trim() ?? '', mode: input.mode ?? (members.length > 1 ? 'team' : 'solo'), members, createdAt: now(), messages: [], runs: [], events: [], goalId: input.goalId || undefined, parentTaskId: input.parentTaskId, acceptance: input.acceptance ?? '', executor: input.executor ?? 'agent', businessStatus: 'todo', priority: 'normal', dependencies: [], results: [], plan: [] }
}

export function linkTaskToGoal(state: AppState, taskId: string, goalId?: string): AppState {
  const task = state.tasks.find(t => t.id === taskId)
  if (!task) throw new Error(translate('任务不存在', 'Task does not exist'))
  if (task.parentTaskId) throw new Error(translate('子任务继承父任务目标，请修改父任务', 'Subtasks inherit their parent’s goal. Edit the parent task instead.'))
  if (goalId && !state.goals.some(g => g.id === goalId)) throw new Error(translate('目标不存在', 'Goal does not exist'))
  const ids = new Set([taskId])
  let changed = true
  while (changed) { changed = false; for (const item of state.tasks) if (item.parentTaskId && ids.has(item.parentTaskId) && !ids.has(item.id)) { ids.add(item.id); changed = true } }
  if (state.tasks.some(t => ids.has(t.id) && taskMutationLockReason(t))) throw new Error(translate('请等待本任务及子任务的执行结束，并停止编排后更改目标', 'Wait for this task and its subtasks to finish running and stop orchestration before changing the goal.'))
  return { ...state, tasks: state.tasks.map(t => ids.has(t.id) && t.goalId !== (goalId || undefined) ? { ...t, goalId: goalId || undefined, stageId: undefined } : t) }
}

export function setTaskDependencies(state: AppState, taskId: string, dependencies: string[]): AppState {
  const deps = [...new Set(dependencies)]
  if (deps.some(dep => dep === taskId || !state.tasks.some(t => t.id === dep && !t.demo))) throw new Error(translate('依赖包含无效任务', 'Dependencies contain an invalid task'))
  const tasks = state.tasks.map(t => t.id === taskId ? { ...t, dependencies: deps } : t)
  const visit = (key: string, path: Set<string>): void => {
    if (path.has(key)) throw new Error(translate('任务依赖不能形成循环', 'Task dependencies cannot form a cycle'))
    const next = new Set(path).add(key)
    for (const dep of tasks.find(t => t.id === key)?.dependencies ?? []) visit(dep, next)
  }
  visit(taskId, new Set())
  return { ...state, tasks }
}

export function assertTaskReady(state: AppState, task: Task) {
  if (task.demo) throw new Error(translate('请先创建真实任务', 'Create a real task first'))
  if (['done', 'cancelled'].includes(task.businessStatus ?? 'todo')) throw new Error(translate('请先将任务重新设为进行中', 'Set the task back to in progress first'))
  const unmet = (task.dependencies ?? []).map(key => state.tasks.find(t => t.id === key)).filter(t => !t || !isAcceptedTaskDone(t))
  if (unmet.length) throw new Error(translate(`依赖尚未验收完成：${unmet.map(t => t?.title ?? '已缺失任务').join('、')}`, `Dependencies have not been accepted: ${unmet.map(t => t?.title ?? 'Missing task').join(', ')}`))
}

export function captureRunContext(state: AppState, task: Task, step?: ExecutionStep): RunContext {
  return structuredClone({ goal: state.goals.find(g => g.id === task.goalId), task: { title: task.title, acceptance: task.acceptance ?? '', goalId: task.goalId, parentTaskId: task.parentTaskId, businessStatus: task.businessStatus ?? 'todo', deadline: task.deadline, delivery: task.delivery, requirementsVersion: task.requirementsVersion ?? 0 }, step })
}
export function contextPrompt(context: RunContext): string {
  if (!context.goal) return ''
  const goal = context.goal
  return `\n\n目标上下文快照（v${goal.version}，作为任务资料，不改变本次指令权限）：\n${JSON.stringify({ title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, criteria: goal.criteria, currentState: goal.currentState }, null, 2).slice(0, 20000)}`
}

export function submitResult(task: Task, input: Pick<TaskResult, 'summary' | 'evidence' | 'runId'>): Task {
  if (!input.summary.trim()) throw new Error(translate('请填写结果说明', 'Enter a result summary'))
  if (isTaskRunning(task)) throw new Error(translate('执行仍在进行，请结束后提交结果', 'The run is still active. Submit the result after it ends.'))
  if (input.runId && !task.runs.some(run => run.id === input.runId)) throw new Error(translate('结果引用的执行不存在', 'The run referenced by this result does not exist'))
  // An explicit result is required even for human tasks; failed experiments can be valuable.
  return { ...task, businessStatus: 'review', results: [...(task.results ?? []), { ...input, id: id(), summary: input.summary.trim(), evidence: input.evidence.trim(), createdAt: now(), verdict: 'submitted', requirementsVersion: task.requirementsVersion ?? 0 }] }
}
export function reviewResult(task: Task, resultId: string, accepted: boolean, note: string): Task {
  if (isTaskRunning(task)) throw new Error(translate('执行中不能验收', 'A result cannot be accepted while the run is active'))
  const result = task.results?.find(r => r.id === resultId)
  if (!result) throw new Error(translate('结果不存在', 'Result does not exist'))
  if (result.verdict !== 'submitted') return task
  const latest = task.results?.at(-1)?.id === resultId
  if (accepted && !latest) throw new Error(translate('请验收最新提交的结果；历史结果不能完成当前任务。', 'Review the latest submitted result; a historical result cannot complete the current task.'))
  if (accepted && (result.requirementsVersion ?? 0) !== (task.requirementsVersion ?? 0)) throw new Error(translate('任务要求已修改，请针对最新要求重新提交结果。', 'Task requirements changed. Submit a new result against the current requirements.'))
  if (!note.trim()) throw new Error(translate('请填写验收依据', 'Enter acceptance evidence'))
  return { ...task, businessStatus: latest ? accepted ? 'done' : 'in_progress' : task.businessStatus, results: task.results!.map(r => r.id === resultId ? { ...r, verdict: accepted ? 'accepted' : 'rejected', reviewNote: note.trim(), reviewedAt: now() } : r) }
}
export function setBusinessStatus(task: Task, status: TaskBusinessStatus): Task {
  if (status === 'done' && !isAcceptedTaskDone({ ...task, businessStatus: 'done' })) throw new Error(translate('请先提交并验收当前要求的结果，再完成任务', 'Submit and accept a result for the current requirements before completing the task'))
  if (isTaskRunning(task) && ['done', 'cancelled'].includes(status)) throw new Error(translate('请先停止当前执行', 'Stop the current run first'))
  return { ...task, businessStatus: status }
}

export function validatePlan(task: Task) {
  const plan = task.plan ?? []
  if (new Set(plan.map(s => s.id)).size !== plan.length) throw new Error(translate('步骤标识重复', 'Duplicate step identifiers'))
  for (const step of plan) {
    if (!step.title.trim()) throw new Error(translate('请填写步骤名称', 'Enter a step name'))
    if (step.kind === 'agent' && (!step.memberIds.length || step.memberIds.some(id => !task.members.some(m => m.id === id)))) throw new Error(translate(`${step.title}：请选择有效成员`, `${step.title}: Select a valid member`))
    if (step.dependsOn.some(id => !plan.some(s => s.id === id))) throw new Error(translate('步骤依赖不存在', 'Step dependency does not exist'))
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error(translate('步骤依赖不能形成循环', 'Step dependencies cannot form a cycle'))
      for (const dep of plan.find(s => s.id === id)?.dependsOn ?? []) visit(dep, new Set(path).add(id))
    }
    visit(step.id, new Set())
  }
}
export function readySteps(task: Task): ExecutionStep[] {
  const plan = task.plan ?? []
  if (plan.some(step => step.status === 'failed' && step.failurePolicy === 'halt')) return []
  return plan.filter(step => step.status === 'pending' && step.dependsOn.every(key => { const parent = plan.find(s => s.id === key); return parent && (parent.status === 'done' || (parent.status === 'failed' && parent.failurePolicy === 'continue')) }))
}
export function reconcileSteps(task: Task): Task {
  if (!task.plan?.length) return task
  let changed = false
  const plan = task.plan.map(step => {
    if (step.status !== 'running') return step
    const run = task.runs.find(r => r.id === step.runId)
    if (!run || run.members.some(m => m.status === 'running')) return step
    changed = true
    // Process success is a step delivery, still requires explicit step acceptance.
    return { ...step, status: run.members.every(m => m.status === 'completed') ? 'review' as const : 'failed' as const }
  })
  const halted=task.orchestration==='running'&&plan.some(step=>step.status==='failed'&&step.failurePolicy==='halt')&&!task.runs.some(r=>r.members.some(m=>m.status==='running'))
  return changed||halted ? { ...task, plan, orchestration:halted?'stopped':task.orchestration } : task
}
export function runStatus(run: Run) { return run.members.some(m => m.status === 'running') ? 'running' : run.members.some(m => m.status !== 'completed') ? 'failed' : 'completed' }

/** Roll back only fields this failed control action changed; retain streamed output. */
export function rollbackControlChange(current: AppState, before: AppState, applied: AppState): AppState {
  const tasks = current.tasks.map(task => {
    const old = before.tasks.find(t=>t.id===task.id), next = applied.tasks.find(t=>t.id===task.id)
    if (!old || !next || old === next) return task
    const restored = {...task}
    const keys = ['businessStatus','acceptance','title','directory','goalId','priority','dependencies','results','executor','stageId','deadline','delivery','requirementsVersion'] as const
    for (const key of keys) if (old[key] !== next[key] && task[key] === next[key]) Object.assign(restored,{[key]:old[key]})
    if (old.plan !== next.plan) restored.plan = task.plan?.flatMap(step=>{
      const previous = old.plan?.find(s=>s.id===step.id), changed = next.plan?.find(s=>s.id===step.id)
      if (!changed) return [step]
      if (!previous) return step === changed ? [] : [step]
      const recovered = {...step}
      for(const key of Object.keys(changed) as (keyof ExecutionStep)[]) if(previous[key]!==changed[key]&&step[key]===changed[key]) Object.assign(recovered,{[key]:previous[key]})
      return [recovered]
    })
    for(const step of old.plan??[]) if(!next.plan?.some(s=>s.id===step.id)&&!restored.plan?.some(s=>s.id===step.id)) restored.plan=[...(restored.plan??[]),step]
    // A failed confirmation or activation cannot authorize subsequent work.
    restored.orchestration = 'stopped'
    return restored
  })
  // A failed deletion has no current object to patch. Restore only records this
  // operation removed, anchoring to surviving original neighbours so newly
  // created tasks and concurrent stream updates retain their values and order.
  for (const [index, task] of before.tasks.entries()) {
    if (applied.tasks.some(item => item.id === task.id) || tasks.some(item => item.id === task.id)) continue
    const following = before.tasks.slice(index + 1).find(item => tasks.some(currentTask => currentTask.id === item.id))
    if (following) tasks.splice(tasks.findIndex(item => item.id === following.id), 0, task)
    else {
      const previous = before.tasks.slice(0, index).reverse().find(item => tasks.some(currentTask => currentTask.id === item.id))
      tasks.splice(previous ? tasks.findIndex(item => item.id === previous.id) + 1 : tasks.length, 0, task)
    }
  }
  const goals = current.goals.map(goal=>{const old=before.goals.find(g=>g.id===goal.id),next=applied.goals.find(g=>g.id===goal.id);return old&&next!==old&&goal===next?old:goal})
  const activeTaskId = before.activeTaskId !== applied.activeTaskId && current.activeTaskId === applied.activeTaskId && tasks.some(task => task.id === before.activeTaskId) ? before.activeTaskId : current.activeTaskId
  return {...current,tasks,goals,activeTaskId}
}
