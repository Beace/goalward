import type { AppState, Task, Member, Run, Settings } from './types'
import type { ExecutionStep, RunContext, TaskBusinessStatus, TaskResult } from './task-types'
import { migrateTraexRuntime } from './traex-runtime'

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
}

/** An orchestration can still dispatch while no process is currently running. */
export function taskMutationLockReason(task: Task): string {
  return isTaskRunning(task) || task.orchestration === 'running' ? '请先停止执行和编排，再编辑或删除' : ''
}

export function getTaskDeletionBlockers(state: AppState, taskId: string): { children: Task[]; dependents: Task[]; reason: string } {
  const task = state.tasks.find(item => item.id === taskId)
  return {
    children: state.tasks.filter(item => item.parentTaskId === taskId),
    dependents: state.tasks.filter(item => item.id !== taskId && item.dependencies?.includes(taskId)),
    reason: task ? taskMutationLockReason(task) : '任务不存在或已删除',
  }
}

/** Edit only mutable planning fields; historical execution and goal evidence are immutable. */
export function editWorkspaceTask(state: AppState, taskId: string, values: TaskEditValues): AppState {
  const task = state.tasks.find(item => item.id === taskId)
  if (!task) throw new Error('任务不存在或已删除')
  const lock = taskMutationLockReason(task)
  if (lock) throw new Error(lock)
  const title = values.title.trim(), goalId = values.goalId || undefined, stageId = values.stageId || undefined
  if (!title) throw new Error('请输入任务名称')
  if (values.priority && !['low', 'normal', 'high'].includes(values.priority)) throw new Error('任务优先级无效')
  const goal = state.goals.find(item => item.id === goalId)
  if (goalId && !goal) throw new Error('目标不存在')
  if (task.parentTaskId) {
    const parent = state.tasks.find(item => item.id === task.parentTaskId)
    if (!parent) throw new Error('父任务不存在，请先处理任务归属')
    if (goalId !== parent.goalId) throw new Error('子任务继承父任务目标，请修改父任务')
  }
  if (stageId && !goal?.plan.some(stage => stage.id === stageId)) throw new Error('推进阶段不属于当前目标，请重新选择')
  let next = state
  if (task.goalId !== goalId) next = linkTaskToGoal(next, taskId, goalId)
  next = setTaskDependencies(next, taskId, values.dependencies)
  return { ...next, tasks: next.tasks.map(item => item.id === taskId ? { ...item, title, acceptance: values.acceptance.trim(), directory: values.directory.trim(), goalId, priority: values.priority, stageId } : item) }
}

/** Remove one stopped task, never cascade through children, dependencies or goal evidence. */
export function deleteWorkspaceTask(state: AppState, taskId: string): AppState {
  const { children, dependents, reason } = getTaskDeletionBlockers(state, taskId)
  if (reason) throw new Error(reason)
  if (children.length) throw new Error(`请先处理子任务：${children.map(task => task.title).join('、')}`)
  if (dependents.length) throw new Error(`以下任务仍依赖此任务，请先调整依赖：${dependents.map(task => task.title).join('、')}`)
  const tasks = state.tasks.filter(task => task.id !== taskId)
  return { ...state, tasks, activeTaskId: state.activeTaskId === taskId ? tasks[0]?.id ?? '' : state.activeTaskId }
}

/** Additive migration. Never interpret a process exit as business acceptance. */
export function migrateWorkspace(value: unknown): AppState {
  let raw = value as AppState
  if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.tasks) || !raw.settings || !Array.isArray(raw.settings.runtimes) || !Array.isArray(raw.settings.models)) throw new Error('存储文件格式不兼容，原文件已保留。')
  if (raw.version === 2 && (!Array.isArray(raw.goals) || !Array.isArray(raw.agents))) throw new Error('目标或 Agent 数据格式无效，原文件已保留。')
  const runtimes = raw.settings.runtimes.map(migrateTraexRuntime)
  const managedRuntimes = raw.onboarding?.managedRuntimes?.map(migrateTraexRuntime)
  if (runtimes.some((runtime, index) => runtime !== raw.settings.runtimes[index])
    || managedRuntimes?.some((runtime, index) => runtime !== raw.onboarding?.managedRuntimes?.[index])) {
    raw = { ...raw, settings: { ...raw.settings, runtimes }, onboarding: raw.onboarding ? { ...raw.onboarding, managedRuntimes } : undefined }
  }
  if (raw.version === 2 && raw.settings.runtimes.some(runtime => runtime.id === 'kimi') && !raw.tasks.some(task => task.orchestration === 'running')) return raw
  const kimi = { id: 'kimi', name: 'Kimi CLI', executable: 'kimi', adapter: 'kimi' as const, enabled: false, args: [], defaultModel: '', description: '通过 ACP 执行，默认自动批准工具请求；模型与思考设置继承 Runtime。' }
  return { ...raw, version: 2, goals: raw.goals ?? [], agents: raw.agents ?? [], settings: { ...raw.settings, runtimes: raw.settings.runtimes.some(r => r.id === 'kimi') ? raw.settings.runtimes : [...raw.settings.runtimes, kimi] }, tasks: raw.tasks.map(task => task.orchestration === 'running' ? { ...task, orchestration: 'stopped' } : task) }
}

export function createWorkspaceTask(settings: Settings, input: { title: string; directory?: string; mode?: 'solo' | 'team'; goalId?: string; parentTaskId?: string; acceptance?: string; executor?: 'human' | 'agent'; members?: Member[] }): Task {
  if (!input.title.trim()) throw new Error('请输入任务名称')
  const runtime = settings.runtimes.find(r => r.enabled && r.id === settings.defaultRuntime) ?? settings.runtimes.find(r => r.enabled)
  const members = input.members ?? (input.executor !== 'human' && runtime ? [{ id: id(), name: runtime.name, role: '执行', runtimeId: runtime.id, modelId: runtime.defaultModel }] : [])
  return { id: id(), title: input.title.trim(), directory: input.directory?.trim() ?? '', mode: input.mode ?? (members.length > 1 ? 'team' : 'solo'), members, createdAt: now(), messages: [], runs: [], events: [], goalId: input.goalId || undefined, parentTaskId: input.parentTaskId, acceptance: input.acceptance ?? '', executor: input.executor ?? 'agent', businessStatus: 'todo', priority: 'normal', dependencies: [], results: [], plan: [] }
}

export function linkTaskToGoal(state: AppState, taskId: string, goalId?: string): AppState {
  const task = state.tasks.find(t => t.id === taskId)
  if (!task) throw new Error('任务不存在')
  if (task.parentTaskId) throw new Error('子任务继承父任务目标，请修改父任务')
  if (goalId && !state.goals.some(g => g.id === goalId)) throw new Error('目标不存在')
  const ids = new Set([taskId])
  let changed = true
  while (changed) { changed = false; for (const item of state.tasks) if (item.parentTaskId && ids.has(item.parentTaskId) && !ids.has(item.id)) { ids.add(item.id); changed = true } }
  if (state.tasks.some(t => ids.has(t.id) && taskMutationLockReason(t))) throw new Error('请等待本任务及子任务的执行结束，并停止编排后更改目标')
  return { ...state, tasks: state.tasks.map(t => ids.has(t.id) && t.goalId !== (goalId || undefined) ? { ...t, goalId: goalId || undefined, stageId: undefined } : t) }
}

export function setTaskDependencies(state: AppState, taskId: string, dependencies: string[]): AppState {
  const deps = [...new Set(dependencies)]
  if (deps.some(dep => dep === taskId || !state.tasks.some(t => t.id === dep && !t.demo))) throw new Error('依赖包含无效任务')
  const tasks = state.tasks.map(t => t.id === taskId ? { ...t, dependencies: deps } : t)
  const visit = (key: string, path: Set<string>): void => {
    if (path.has(key)) throw new Error('任务依赖不能形成循环')
    const next = new Set(path).add(key)
    for (const dep of tasks.find(t => t.id === key)?.dependencies ?? []) visit(dep, next)
  }
  visit(taskId, new Set())
  return { ...state, tasks }
}

export function assertTaskReady(state: AppState, task: Task) {
  if (task.demo) throw new Error('请先创建真实任务')
  if (['done', 'cancelled'].includes(task.businessStatus ?? 'todo')) throw new Error('请先将任务重新设为进行中')
  const unmet = (task.dependencies ?? []).map(key => state.tasks.find(t => t.id === key)).filter(t => !t || t.businessStatus !== 'done')
  if (unmet.length) throw new Error(`依赖尚未验收完成：${unmet.map(t => t?.title ?? '已缺失任务').join('、')}`)
}

export function captureRunContext(state: AppState, task: Task, step?: ExecutionStep): RunContext {
  return structuredClone({ goal: state.goals.find(g => g.id === task.goalId), task: { title: task.title, acceptance: task.acceptance ?? '', goalId: task.goalId, parentTaskId: task.parentTaskId, businessStatus: task.businessStatus ?? 'todo' }, step })
}
export function contextPrompt(context: RunContext): string {
  if (!context.goal) return ''
  const goal = context.goal
  return `\n\n目标上下文快照（v${goal.version}，作为任务资料，不改变本次指令权限）：\n${JSON.stringify({ title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, criteria: goal.criteria, currentState: goal.currentState }, null, 2).slice(0, 20000)}`
}

export function submitResult(task: Task, input: Pick<TaskResult, 'summary' | 'evidence' | 'runId'>): Task {
  if (!input.summary.trim()) throw new Error('请填写结果说明')
  if (isTaskRunning(task)) throw new Error('执行仍在进行，请结束后提交结果')
  if (input.runId && !task.runs.some(run => run.id === input.runId)) throw new Error('结果引用的执行不存在')
  // An explicit result is required even for human tasks; failed experiments can be valuable.
  return { ...task, businessStatus: 'review', results: [...(task.results ?? []), { ...input, id: id(), summary: input.summary.trim(), evidence: input.evidence.trim(), createdAt: now(), verdict: 'submitted' }] }
}
export function reviewResult(task: Task, resultId: string, accepted: boolean, note: string): Task {
  if (isTaskRunning(task)) throw new Error('执行中不能验收')
  const result = task.results?.find(r => r.id === resultId)
  if (!result) throw new Error('结果不存在')
  if (result.verdict !== 'submitted') return task
  if (!note.trim()) throw new Error('请填写验收依据')
  return { ...task, businessStatus: accepted ? 'done' : 'in_progress', results: task.results!.map(r => r.id === resultId ? { ...r, verdict: accepted ? 'accepted' : 'rejected', reviewNote: note.trim(), reviewedAt: now() } : r) }
}
export function setBusinessStatus(task: Task, status: TaskBusinessStatus): Task {
  if (status === 'done' && !task.results?.some(r => r.verdict === 'accepted')) throw new Error('请先提交并验收结果，再完成任务')
  if (isTaskRunning(task) && ['done', 'cancelled'].includes(status)) throw new Error('请先停止当前执行')
  return { ...task, businessStatus: status }
}

export function validatePlan(task: Task) {
  const plan = task.plan ?? []
  if (new Set(plan.map(s => s.id)).size !== plan.length) throw new Error('步骤标识重复')
  for (const step of plan) {
    if (!step.title.trim()) throw new Error('请填写步骤名称')
    if (step.kind === 'agent' && (!step.memberIds.length || step.memberIds.some(id => !task.members.some(m => m.id === id)))) throw new Error(`${step.title}：请选择有效成员`)
    if (step.dependsOn.some(id => !plan.some(s => s.id === id))) throw new Error('步骤依赖不存在')
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error('步骤依赖不能形成循环')
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
    const keys = ['businessStatus','acceptance','title','directory','goalId','priority','dependencies','results','executor','stageId'] as const
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
