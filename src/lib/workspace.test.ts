import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal, updateGoalState } from './goals'
import { assertTaskReady, captureRunContext, createWorkspaceTask, linkTaskToGoal, migrateWorkspace, readySteps, reconcileSteps, reviewResult, setBusinessStatus, setTaskDependencies, submitResult, validatePlan } from './workspace'
import type { AppState, Task } from './types'
import type { ExecutionStep } from './task-types'

function fixture() {
  const seed = createInitialState()
  const goal = createGoal({ title: 'Explore storage options', expected: 'Make an evidence-based choice', currentSummary: 'Two candidates already exist' })
  const task = createWorkspaceTask(seed.settings, { title: 'Comparison and experiments', goalId: goal.id, acceptance: 'Provide comparison and verification records' })
  const state: AppState = { ...seed, goals: [goal], agents: [], tasks: [task], activeTaskId: task.id }
  return { goal, task, state }
}
function execution(task: Task, status: 'running' | 'completed' | 'failed' = 'completed'): Task {
  const settings = createInitialState().settings
  return { ...task, runs: [{ id: 'run-1', createdAt: task.createdAt, prompt: 'Run experiments', directory: task.directory, members: [{ ...task.members[0], runtime: settings.runtimes[0], model: '', status }] }] }
}
function step(id: string, dependsOn: string[] = [], overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return { id, title: `Step ${id}`, instructions: '', memberIds: [], dependsOn, kind: 'human', expectedOutput: 'Check records', failurePolicy: 'halt', status: 'pending', ...overrides }
}

describe('workspace migration and independent planning', () => {
  it('preserves v1 task/run evidence and leaves business acceptance unknown', () => {
    const { state, task } = fixture()
    const oldTask = execution(task)
    delete oldTask.businessStatus
    const legacy = { ...state, version: 1, goals: undefined, agents: undefined, tasks: [oldTask], settings: { ...state.settings, runtimes: state.settings.runtimes.filter(runtime => runtime.id !== 'kimi') } }
    const migrated = migrateWorkspace(legacy)
    expect(migrated.version).toBe(2)
    expect(migrated.goals).toEqual([])
    expect(migrated.agents).toEqual([])
    expect(migrated.tasks[0].runs).toEqual(oldTask.runs)
    expect(migrated.tasks[0].businessStatus).toBeUndefined()
    expect(migrated.settings.runtimes.filter(runtime => runtime.id === 'kimi')).toHaveLength(1)
    expect(migrateWorkspace(migrated).settings.runtimes.filter(runtime => runtime.id === 'kimi')).toHaveLength(1)
    expect(legacy.settings.runtimes.some(runtime => runtime.id === 'kimi')).toBe(false)
  })

  it('allows planning human or Agent tasks before an executable or directory is available', () => {
    const settings = createInitialState().settings
    settings.runtimes = []
    const human = createWorkspaceTask(settings, { title: 'Manually confirm requirements', executor: 'human' })
    const agent = createWorkspaceTask(settings, { title: 'Follow-up research', executor: 'agent' })
    expect(human.members).toEqual([])
    expect(agent.members).toEqual([])
    expect(human.directory).toBe('')
    expect(human.businessStatus).toBe('todo')
    expect(() => createWorkspaceTask(settings, { title: ' ' })).toThrow('请输入任务名称')
  })
})

describe('goal association and execution context', () => {
  it('cascades parent association to descendants and blocks reassignment during any descendant execution', () => {
    const { state, task } = fixture()
    const otherGoal = createGoal({ title: 'Another goal' })
    const child = createWorkspaceTask(state.settings, { title: 'Child task', goalId: task.goalId, parentTaskId: task.id })
    const grandchild = createWorkspaceTask(state.settings, { title: 'Next-level task', goalId: task.goalId, parentTaskId: child.id })
    const withChildren = { ...state, goals: [...state.goals, otherGoal], tasks: [task, child, grandchild] }
    const linked = linkTaskToGoal(withChildren, task.id, otherGoal.id)
    expect(linked.tasks.every(item => item.goalId === otherGoal.id)).toBe(true)
    expect(withChildren.tasks[0].goalId).toBe(task.goalId)
    expect(() => linkTaskToGoal(linked, child.id)).toThrow('继承父任务')
    expect(() => linkTaskToGoal({ ...linked, tasks: [task, child, execution(grandchild, 'running')] }, task.id)).toThrow('执行结束')
  })

  it('captures goal, current state and task criteria independently of all later edits', () => {
    const { state, task } = fixture()
    task.delivery = 'Comparison report'
    task.deadline = '2026-10-16'
    task.requirementsVersion = 2
    const context = captureRunContext(state, task)
    state.goals[0] = updateGoalState(state.goals[0], { summary: 'Third candidate added later', reason: 'User addition' })
    task.acceptance = 'Acceptance requirements revised later'
    task.delivery = 'Revised report'
    task.deadline = '2026-10-18'
    task.requirementsVersion = 3
    expect(context.goal?.currentState.summary).toBe('Two candidates already exist')
    expect(context.task.acceptance).toBe('Provide comparison and verification records')
    expect(context.task).toMatchObject({ delivery: 'Comparison report', deadline: '2026-10-16', requirementsVersion: 2 })
    expect(captureRunContext({ ...state, goals: [] }, task).goal).toBeUndefined()
  })
})

describe('business acceptance and dependency gates', () => {
  it('keeps a completed execution separate from task acceptance and deduplicates acceptance', () => {
    const { task } = fixture()
    const finished = execution(task)
    expect(finished.businessStatus).toBe('todo')
    expect(() => setBusinessStatus(finished, 'done')).toThrow('提交并验收')
    const submitted = submitResult(finished, { summary: 'Option A ruled out', evidence: 'Experiment records', runId: 'run-1' })
    expect(submitted.businessStatus).toBe('review')
    expect(() => reviewResult(submitted, submitted.results![0].id, true, '')).toThrow('验收依据')
    const accepted = reviewResult(submitted, submitted.results![0].id, true, 'Negative experimental results meet requirements; evidence checked')
    expect(accepted.businessStatus).toBe('done')
    expect(reviewResult(accepted, accepted.results![0].id, true, 'Repeated')).toBe(accepted)
    expect(() => submitResult(execution(task, 'running'), { summary: 'Premature submission', evidence: '' })).toThrow('执行仍在进行')
  })

  it('validates cycles and waits for business acceptance rather than a predecessor process exit', () => {
    const { state, task } = fixture()
    const dependent = createWorkspaceTask(state.settings, { title: 'Make decisions based on results' })
    const wired = setTaskDependencies({ ...state, tasks: [execution(task), dependent] }, dependent.id, [task.id, task.id])
    expect(wired.tasks[1].dependencies).toEqual([task.id])
    expect(() => assertTaskReady(wired, wired.tasks[1])).toThrow('依赖尚未验收')
    expect(() => setTaskDependencies(wired, task.id, [dependent.id])).toThrow('不能形成循环')
    expect(() => setTaskDependencies(wired, dependent.id, ['missing'])).toThrow('无效任务')
    const first = submitResult(wired.tasks[0], { summary: 'Prerequisite task completed', evidence: '/result.md' })
    wired.tasks[0] = reviewResult(first, first.results!.at(-1)!.id, true, 'Artifacts verified')
    expect(() => assertTaskReady(wired, wired.tasks[1])).not.toThrow()
  })
})

describe('execution plan readiness and terminal reconciliation', () => {
  it('makes only accepted predecessor steps ready, respecting explicit failure policy', () => {
    const { task } = fixture()
    task.plan = [step('a', [], { status: 'review' }), step('b', ['a'])]
    expect(readySteps(task)).toEqual([])
    task.plan[0].status = 'done'
    expect(readySteps(task).map(item => item.id)).toEqual(['b'])
    task.plan[0] = { ...task.plan[0], status: 'failed', failurePolicy: 'halt' }
    expect(readySteps(task)).toEqual([])
    task.plan[0].failurePolicy = 'continue'
    expect(readySteps(task).map(item => item.id)).toEqual(['b'])
    task.plan = [step('a', ['b']), step('b', ['a'])]
    expect(() => validatePlan(task)).toThrow('不能形成循环')
  })

  it('does not let a historical submitted result mark newer work accepted or unblock dependencies', () => {
    const { task, state } = fixture()
    const first = submitResult(task, { summary: 'Old submission', evidence: '/old.md' })
    const second = submitResult(first, { summary: 'New submission', evidence: '/new.md' })
    expect(() => reviewResult(second, first.results![0].id, true, 'Old artifact passed')).toThrow('最新提交')
    const latestAccepted = reviewResult(second, second.results!.at(-1)!.id, true, 'New artifact accepted')
    expect(reviewResult(latestAccepted, first.results![0].id, false, 'Old artifact rejected').businessStatus).toBe('done')
    const dependent = createWorkspaceTask(state.settings, { title: 'Follow-up task' })
    dependent.dependencies = [task.id]
    expect(() => assertTaskReady({ ...state, tasks: [{ ...second, businessStatus: 'done' }, dependent] }, dependent)).toThrow('依赖尚未验收')
    expect(() => assertTaskReady({ ...state, tasks: [latestAccepted, dependent] }, dependent)).not.toThrow()
  })

  it('turns successful process completion into step review and failure into step failure', () => {
    const { task } = fixture()
    const running = { ...execution(task, 'running'), plan: [step('a', [], { status: 'running', runId: 'run-1' })] }
    expect(reconcileSteps(running)).toBe(running)
    const completed = { ...execution(task), plan: running.plan }
    expect(reconcileSteps(completed).plan?.[0].status).toBe('review')
    const failed = { ...execution(task, 'failed'), plan: running.plan }
    expect(reconcileSteps(failed).plan?.[0].status).toBe('failed')
    expect(completed.plan[0].status).toBe('running')
  })
})
