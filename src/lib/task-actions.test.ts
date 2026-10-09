import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal, createStateEntry, proposeGoalState, saveGoalReview, updateGoalState } from './goals'
import { captureRunContext, createWorkspaceTask, deleteWorkspaceTask, editWorkspaceTask, getTaskDeletionBlockers, linkTaskToGoal, rollbackControlChange, taskMutationLockReason } from './workspace'
import type { TaskEditValues } from './workspace'
import type { AppState, Task } from './types'

function fixture() {
  const seed = createInitialState()
  const goal = createGoal({ title: '验证设计', expected: '交付可审阅结果' })
  goal.plan = [{ id: 'old-stage', title: '验证阶段', description: '', status: 'active' }]
  const otherGoal = createGoal({ title: '新目标' })
  otherGoal.plan = [{ id: 'new-stage', title: '新阶段', description: '', status: 'planned' }]
  const task = { ...createWorkspaceTask(seed.settings, { title: '待修改任务', directory: '/old', goalId: goal.id, acceptance: '旧验收要求' }), stageId: 'old-stage' }
  const other = createWorkspaceTask(seed.settings, { title: '其他任务' })
  const state: AppState = { ...seed, tasks: [task, other], goals: [goal, otherGoal], agents: [], activeTaskId: task.id }
  return { state, task, other, goal, otherGoal }
}

function values(task: Task, overrides: Partial<TaskEditValues> = {}): TaskEditValues {
  return { title: task.title, acceptance: task.acceptance ?? '', directory: task.directory, goalId: task.goalId, priority: task.priority, stageId: task.stageId, dependencies: task.dependencies ?? [], ...overrides }
}

function running(task: Task): Task {
  return { ...task, runs: [{ id: 'run', prompt: '任务指令', createdAt: task.createdAt, directory: task.directory, members: [{ ...task.members[0], runtime: createInitialState().settings.runtimes[0], model: '', status: 'running' }] }] }
}

describe('editing tasks against current workspace state', () => {
  it('updates only planning fields and retains historical execution and goal evidence', () => {
    const { state, task } = fixture()
    const completed = running(task)
    completed.runs[0].members[0].status = 'completed'
    completed.runs[0].context = captureRunContext(state, task)
    completed.messages = [{ id: 'message', role: 'assistant', text: '原始结果', createdAt: task.createdAt }]
    completed.businessStatus = 'done'
    completed.results = [{ id: 'result', summary: '结果', evidence: '记录', createdAt: task.createdAt, verdict: 'accepted' }]
    const before = { ...state, tasks: [completed, state.tasks[1]] }
    const next = editWorkspaceTask(before, task.id, values(task, { title: ' 新名称 ', acceptance: ' 新验收 ', directory: ' /new ', priority: 'high' }))
    expect(next.tasks[0]).toMatchObject({ title: '新名称', acceptance: '新验收', directory: '/new', priority: 'high', businessStatus: 'done' })
    for (const field of ['runs', 'messages', 'members', 'events', 'results', 'plan'] as const) expect(next.tasks[0][field]).toBe(completed[field])
    expect(next.tasks[0].runs[0].context?.task.title).toBe('待修改任务')
    expect(next.tasks[0].runs[0].directory).toBe('/old')
    expect(next.goals).toBe(before.goals)
    expect(next.agents).toBe(before.agents)
    expect(next.tasks[1]).toBe(before.tasks[1])
    expect(completed.title).toBe('待修改任务')
  })

  it('allows an independent task without a runtime, directory or goal', () => {
    const { state, task } = fixture()
    const next = editWorkspaceTask(state, task.id, values(task, { title: '人工计划', directory: '', goalId: undefined, stageId: undefined }))
    expect(next.tasks[0].goalId).toBeUndefined()
    expect(next.tasks[0].stageId).toBeUndefined()
    expect(next.tasks[0].directory).toBe('')
  })

  it('rejects a deleted task, blank title, absent goal and foreign stage', () => {
    const { state, task, otherGoal } = fixture()
    expect(() => editWorkspaceTask({ ...state, tasks: [] }, task.id, values(task))).toThrow('已删除')
    expect(() => editWorkspaceTask(state, task.id, values(task, { title: ' \n ' }))).toThrow('任务名称')
    expect(() => editWorkspaceTask(state, task.id, values(task, { goalId: 'missing' }))).toThrow('目标不存在')
    expect(() => editWorkspaceTask(state, task.id, values(task, { goalId: otherGoal.id }))).toThrow('推进阶段不属于')
    expect(() => editWorkspaceTask(state, task.id, values(task, { goalId: undefined }))).toThrow('推进阶段不属于')
  })

  it.each(['execution', 'orchestration'] as const)('rechecks the latest %s lock, including plans waiting without processes', kind => {
    const { state, task } = fixture()
    const latest = kind === 'execution' ? running(task) : { ...task, orchestration: 'running' as const }
    expect(taskMutationLockReason(task)).toBe('')
    expect(taskMutationLockReason(latest)).toContain('停止执行和编排')
    expect(() => editWorkspaceTask({ ...state, tasks: [latest] }, task.id, values(task, { title: '弹窗中的草稿' }))).toThrow('停止执行和编排')
  })

  it('validates dependency existence, self references, cycles and deduplicates valid dependencies', () => {
    const { state, task, other } = fixture()
    expect(() => editWorkspaceTask(state, task.id, values(task, { dependencies: ['missing'] }))).toThrow('无效任务')
    expect(() => editWorkspaceTask(state, task.id, values(task, { dependencies: [task.id] }))).toThrow('无效任务')
    const cycle = { ...state, tasks: [task, { ...other, dependencies: [task.id] }] }
    expect(() => editWorkspaceTask(cycle, task.id, values(task, { dependencies: [other.id] }))).toThrow('不能形成循环')
    expect(editWorkspaceTask(state, task.id, values(task, { dependencies: [other.id, other.id] })).tasks[0].dependencies).toEqual([other.id])
  })

  it('enforces child inheritance and refuses an orphan rather than silently changing ownership', () => {
    const { state, task, otherGoal } = fixture()
    const child = createWorkspaceTask(state.settings, { title: '子任务', parentTaskId: task.id, goalId: task.goalId })
    const current = { ...state, tasks: [...state.tasks, child] }
    expect(() => editWorkspaceTask(current, child.id, values(child, { goalId: otherGoal.id }))).toThrow('子任务继承父任务')
    expect(() => editWorkspaceTask({ ...current, tasks: [child] }, child.id, values(child))).toThrow('父任务不存在')
    expect(editWorkspaceTask(current, child.id, values(child, { title: '修改子任务' })).tasks.at(-1)?.goalId).toBe(task.goalId)
  })

  it('propagates a parent goal change and clears only obsolete descendant stages', () => {
    const { state, task, otherGoal } = fixture()
    const child = { ...createWorkspaceTask(state.settings, { title: '子任务', parentTaskId: task.id, goalId: task.goalId }), stageId: 'old-stage' }
    const grandchild = { ...createWorkspaceTask(state.settings, { title: '孙任务', parentTaskId: child.id, goalId: task.goalId }), stageId: 'old-stage' }
    const current = { ...state, tasks: [task, child, grandchild] }
    const next = editWorkspaceTask(current, task.id, values(task, { goalId: otherGoal.id, stageId: 'new-stage' }))
    expect(next.tasks.map(item => item.goalId)).toEqual([otherGoal.id, otherGoal.id, otherGoal.id])
    expect(next.tasks.map(item => item.stageId)).toEqual(['new-stage', undefined, undefined])
    expect(linkTaskToGoal(current, task.id, task.goalId).tasks.map(item => item.stageId)).toEqual(['old-stage', 'old-stage', 'old-stage'])
    expect(current.tasks.map(item => item.stageId)).toEqual(['old-stage', 'old-stage', 'old-stage'])
  })

  it.each(['execution', 'orchestration'] as const)('blocks parent goal changes when a descendant has active %s', kind => {
    const { state, task, otherGoal } = fixture()
    const child = createWorkspaceTask(state.settings, { title: '子任务', parentTaskId: task.id, goalId: task.goalId })
    const locked = kind === 'execution' ? running(child) : { ...child, orchestration: 'running' as const }
    const current = { ...state, tasks: [task, locked] }
    expect(() => editWorkspaceTask(current, task.id, values(task, { goalId: otherGoal.id, stageId: undefined }))).toThrow('执行结束')
    expect(editWorkspaceTask(current, task.id, values(task, { title: '仅修改父任务名称' })).tasks[1]).toBe(locked)
  })
})

describe('deleting stopped tasks without cascading or rewriting evidence', () => {
  it('reports relation blockers separately and refuses implicit child deletion or dependency removal', () => {
    const { state, task, other } = fixture()
    const child = createWorkspaceTask(state.settings, { title: '子任务', parentTaskId: task.id })
    const dependent = { ...other, dependencies: [task.id] }
    const current = { ...state, tasks: [task, child, dependent] }
    expect(getTaskDeletionBlockers(current, task.id)).toEqual({ reason: '', children: [child], dependents: [dependent] })
    expect(() => deleteWorkspaceTask(current, task.id)).toThrow('子任务')
    expect(() => deleteWorkspaceTask({ ...current, tasks: [task, dependent] }, task.id)).toThrow('其他任务')
    expect(current.tasks).toHaveLength(3)
    expect(dependent.dependencies).toEqual([task.id])
  })

  it.each(['execution', 'orchestration'] as const)('rejects deletion under the latest %s lock', kind => {
    const { state, task } = fixture()
    const locked = kind === 'execution' ? running(task) : { ...task, orchestration: 'running' as const }
    const current = { ...state, tasks: [locked] }
    expect(getTaskDeletionBlockers(current, task.id).reason).toContain('停止执行和编排')
    expect(() => deleteWorkspaceTask(current, task.id)).toThrow('停止执行和编排')
  })

  it('keeps goal state, proposals, reviews and Agent references untouched', () => {
    const { state, task, other, goal } = fixture()
    const source = { kind: 'task' as const, label: '任务结果：待修改任务', taskId: task.id, runId: 'original-run', reference: '/artifact.md' }
    const entry = createStateEntry('artifact', '已采纳成果', source)
    let evidence = updateGoalState(goal, { appendEntries: [entry], source, reason: '验收完成' })
    evidence = proposeGoalState(evidence, { title: '后续待核对的变化', entries: [entry], source })
    evidence = saveGoalReview(evidence, { judgement: 'on_track', summary: '符合预期', evidence: '已核对记录', nextActions: [] })
    const current = { ...state, goals: [evidence] }
    const next = deleteWorkspaceTask(current, task.id)
    expect(next.tasks).toEqual([other])
    expect(next.goals).toBe(current.goals)
    expect(next.agents).toBe(current.agents)
    expect(next.goals[0].currentState.entries[0].source).toEqual(source)
    expect(next.goals[0].reviews[0].afterState.entries[0].source).toEqual(source)
    expect(next.activeTaskId).toBe(other.id)
    expect(next.tasks[0]).toBe(other)
  })

  it('retains current selection for other deletions and handles deleting the final task', () => {
    const { state, task, other } = fixture()
    expect(deleteWorkspaceTask(state, other.id).activeTaskId).toBe(task.id)
    expect(deleteWorkspaceTask({ ...state, tasks: [task] }, task.id)).toMatchObject({ tasks: [], activeTaskId: '' })
    expect(getTaskDeletionBlockers({ ...state, tasks: [] }, task.id).reason).toContain('已删除')
    expect(() => deleteWorkspaceTask({ ...state, tasks: [] }, task.id)).toThrow('已删除')
  })
})

describe('rolling back a failed task control write', () => {
  it('restores a deleted record at its relative position without losing new tasks or streamed output', () => {
    const { state, task, other } = fixture()
    const prior = createWorkspaceTask(state.settings, { title: '之前任务' })
    const before = { ...state, tasks: [prior, task, other] }
    const applied = deleteWorkspaceTask(before, task.id)
    const created = createWorkspaceTask(state.settings, { title: '刚创建的任务' })
    const streamed = { ...other, messages: [{ id: 'later-message', role: 'assistant' as const, text: '并发输出', createdAt: task.createdAt }] }
    const current = { ...applied, tasks: [created, prior, streamed] }
    const recovered = rollbackControlChange(current, before, applied)
    expect(recovered.tasks.map(item => item.id)).toEqual([created.id, prior.id, task.id, other.id])
    expect(recovered.tasks[0]).toBe(created)
    expect(recovered.tasks[2]).toBe(task)
    expect(recovered.tasks[3]).toBe(streamed)
    expect(recovered.activeTaskId).toBe(task.id)
    expect(current.tasks).toEqual([created, prior, streamed])
  })

  it('restores a deleted final task but keeps a later explicit selection', () => {
    const { state, task, other } = fixture()
    const before = { ...state, tasks: [other, task] }
    const applied = deleteWorkspaceTask(before, task.id)
    const created = createWorkspaceTask(state.settings, { title: '并发创建' })
    const current = { ...applied, tasks: [created, other], activeTaskId: created.id }
    const recovered = rollbackControlChange(current, before, applied)
    expect(recovered.tasks.map(item => item.id)).toEqual([created.id, other.id, task.id])
    expect(recovered.activeTaskId).toBe(created.id)
    const empty = deleteWorkspaceTask({ ...state, tasks: [task] }, task.id)
    expect(rollbackControlChange(empty, { ...state, tasks: [task] }, empty)).toMatchObject({ tasks: [task], activeTaskId: task.id })
  })

  it('never replaces a concurrently restored record and never resurrects unrelated deleted records', () => {
    const { state, task, other } = fixture()
    const applied = deleteWorkspaceTask(state, task.id)
    const restored = { ...task, title: '稍后恢复并修改' }
    const recovered = rollbackControlChange({ ...applied, tasks: [restored] }, state, applied)
    expect(recovered.tasks).toEqual([restored])
    expect(recovered.tasks[0]).toBe(restored)
    expect(recovered.tasks.some(item => item.id === other.id)).toBe(false)
  })

  it('rolls back only failed edit fields and preserves concurrent edits and execution events', () => {
    const { state, task } = fixture()
    const applied = editWorkspaceTask(state, task.id, values(task, { title: '未保存名称', directory: '/unsaved' }))
    const message = { id: 'later-message', role: 'assistant' as const, text: '后来输出', createdAt: task.createdAt }
    const current = { ...applied, tasks: [{ ...applied.tasks[0], title: '另一操作更新', messages: [message] }, applied.tasks[1]] }
    const recovered = rollbackControlChange(current, state, applied)
    expect(recovered.tasks[0]).toMatchObject({ title: '另一操作更新', directory: '/old', messages: [message], orchestration: 'stopped' })
    expect(recovered.tasks[1]).toBe(state.tasks[1])
  })
})
