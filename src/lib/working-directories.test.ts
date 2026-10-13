import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal } from './goals'
import { createWorkspaceTask, editWorkspaceTask, linkTaskToGoal, migrateWorkspace } from './workspace'
import { applyGoalWorkingDirectories, getGoalWorkingDirectories, getTaskWorkingDirectories, migrateWorkingDirectories, normalizeWorkingDirectories } from './working-directories'
import { adoptGoalTaskProposals, rollbackGoalAssistantAction } from './goal-assistant'
import { getTaskArtifacts } from './artifacts'
import type { AppState, Task } from './types'

function fixture(): { state: AppState; task: Task } {
  const seed = createInitialState()
  const goal = { ...createGoal({ title: 'Shared research workspace' }), workingDirectories: ['/projects/primary', '/research/data'] }
  const task = createWorkspaceTask(seed.settings, { title: 'Existing task', goalId: goal.id, directory: '/legacy/project' })
  return { state: { ...seed, goals: [goal], tasks: [task], agents: [], activeTaskId: task.id }, task }
}
const editValues = (task: Task) => ({ title: task.title, acceptance: task.acceptance ?? '', directory: task.directory, goalId: task.goalId, priority: task.priority, dependencies: task.dependencies ?? [] })

describe('goal workspace ownership and additive migration', () => {
  it('deduplicates ordered roots without resolving symlinks or parent traversals', () => {
    expect(normalizeWorkingDirectories([' /project/ ', '/data', '/project', '/', ' ', '/project/link/../src', null])).toEqual(['/project', '/data', '/', '/project/link/../src'])
  })

  it('retains every legacy business workspace in order and leaves historical executions untouched', () => {
    const { state, task } = fixture()
    delete state.goals[0].workingDirectories
    const other = { ...createWorkspaceTask(state.settings, { title: 'Data', goalId: task.goalId, directory: '/legacy/data' }), workingDirectories: ['/legacy/data', '/more/data'] }
    const assistant = { ...createWorkspaceTask(state.settings, { title: 'Goal assistant', goalId: task.goalId, directory: '/app/assistant' }), kind: 'goal_assistant' as const }
    const historical = { id: 'run', createdAt: task.createdAt, directory: '/legacy/project', workingDirectories: ['/legacy/project', '/past/extra'], prompt: 'Historical request', members: [] }
    task.runs = [historical]
    const before = { ...state, tasks: [task, other, assistant] }
    const next = migrateWorkspace(before)
    expect(next.goals[0].workingDirectories).toEqual(['/legacy/project', '/legacy/data', '/more/data'])
    expect(next.tasks.every(item => item.directory === '/legacy/project')).toBe(true)
    expect(next.tasks[0].runs[0]).toBe(historical)
    expect(next.tasks[0].runs[0].workingDirectories).toEqual(['/legacy/project', '/past/extra'])
    expect(task.directory).toBe('/legacy/project')
    expect(other.directory).toBe('/legacy/data')
    expect(migrateWorkspace(next)).toBe(next)
  })

  it('preserves an existing explicit goal workspace instead of reimporting stale task roots', () => {
    const { state, task } = fixture()
    expect(getTaskWorkingDirectories(state, task)).toEqual(['/projects/primary', '/research/data'])
    const next = migrateWorkingDirectories(state)
    expect(next.goals).toBe(state.goals)
    expect(next.tasks[0].directory).toBe('/projects/primary')
    expect(next.tasks[0].workingDirectories).toEqual(['/projects/primary', '/research/data'])
    expect(migrateWorkingDirectories(next)).toBe(next)
  })

  it('keeps legacy relative artifact links bound to their original directory, including deferred history', () => {
    const { state, task } = fixture()
    const oldMessage = { id: 'legacy-reply', role: 'assistant' as const, createdAt: task.createdAt, text: '[Old report](report.md)' }
    const migrated = migrateWorkingDirectories({ ...state, tasks: [{ ...task, historyPending: true, messages: [] }] })
    expect(migrated.tasks[0].legacyArtifactDirectory).toBe('/legacy/project')
    const recovered = { ...migrated.tasks[0], historyPending: false, messages: [oldMessage] }
    const artifact = getTaskArtifacts(recovered)[0]
    expect(artifact.directory).toBe('/legacy/project')
    const changed = applyGoalWorkingDirectories({ ...migrated, tasks: [recovered] }, state.goals[0].id, ['/another/project'])
    expect(getTaskArtifacts(changed.tasks[0])[0].directory).toBe('/legacy/project')
    expect(changed.tasks[0].directory).toBe('/another/project')
  })

  it('uses a saved assistant workspace only when there are no legacy business roots', () => {
    const { state, task } = fixture()
    delete state.goals[0].workingDirectories
    expect(getGoalWorkingDirectories({ ...state, tasks: [{ ...task, kind: 'goal_assistant', directory: '/app/goal' }] }, state.goals[0])).toEqual(['/app/goal', '/legacy/project'])
  })

  it('edits future roots without rewriting an active native turn or deleting file references from historical runs', () => {
    const { state, task } = fixture()
    const runtime = state.settings.runtimes[0]
    const run = { id: 'active', createdAt: task.createdAt, directory: task.directory, workingDirectories: [task.directory], prompt: 'Running', members: [{ ...task.members[0], runtime, model: '', status: 'running' as const }] }
    const active = { ...task, runs: [run] }
    const before = { ...state, tasks: [active] }
    const next = applyGoalWorkingDirectories(before, state.goals[0].id, ['/research/data', '/new/project'])
    expect(next.tasks[0]).toBe(active)
    expect(next.tasks[0].runs[0]).toBe(run)
    expect(getTaskWorkingDirectories(next, active)).toEqual(['/research/data', '/new/project'])
    expect(before.goals[0].workingDirectories).toEqual(['/projects/primary', '/research/data'])
    expect(() => applyGoalWorkingDirectories(next, state.goals[0].id, [])).toThrow('保留一个主工作目录')
    expect(() => applyGoalWorkingDirectories(next, state.goals[0].id, ['relative/path'])).toThrow('绝对目录')
  })
})

describe('every task path inherits the goal workspace', () => {
  it('ignores a per-task directory edit for a goal task, while preserving standalone directory edits', () => {
    const { state, task } = fixture()
    const next = editWorkspaceTask(state, task.id, { ...editValues(task), directory: '/incorrect/override' })
    expect(next.tasks[0].directory).toBe('/projects/primary')
    expect(next.tasks[0].workingDirectories).toEqual(['/projects/primary', '/research/data'])
    const standalone = editWorkspaceTask(next, task.id, { ...editValues(task), goalId: undefined, directory: '/standalone' })
    expect(standalone.tasks[0].workingDirectories).toEqual(['/standalone'])
  })

  it('reassociates the entire child tree with the new goal roots without touching run history', () => {
    const { state, task } = fixture()
    const other = { ...createGoal({ title: 'Other goal' }), workingDirectories: ['/other', '/other/data'] }
    const child = createWorkspaceTask(state.settings, { title: 'Child task', goalId: task.goalId, parentTaskId: task.id, directory: '/old/child' })
    const next = linkTaskToGoal({ ...state, goals: [...state.goals, other], tasks: [task, child] }, task.id, other.id)
    expect(next.tasks.map(item => item.goalId)).toEqual([other.id, other.id])
    expect(next.tasks.map(item => item.workingDirectories)).toEqual([other.workingDirectories, other.workingDirectories])
    expect(next.tasks.every(item => item.directory === '/other')).toBe(true)
    expect(next.tasks[0].runs).toBe(task.runs)
  })

  it('adopts suggestions into the goal roots even when the configured default points elsewhere', () => {
    const { state } = fixture()
    const goal = state.goals[0]
    goal.assistant = { confirmedVersion: goal.version, proposals: [{ id: 'suggestion', title: 'Investigate application requirements', delivery: 'Report', acceptance: 'Confirm evidence', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version }] }
    const next = adoptGoalTaskProposals({ ...state, settings: { ...state.settings, defaultDirectory: '/unrelated/default' } }, goal.id)
    const adopted = next.tasks.find(task => task.id === next.goals[0].assistant?.proposals?.[0].taskId)!
    expect(adopted.directory).toBe('/projects/primary')
    expect(adopted.workingDirectories).toEqual(['/projects/primary', '/research/data'])
  })

  it('creates standalone work without requiring a directory field and retains explicit multi-root snapshots', () => {
    const { state } = fixture()
    expect(createWorkspaceTask({ ...state.settings, defaultDirectory: '/default' }, { title: '独立任务' }).directory).toBe('/default')
    const task = createWorkspaceTask(state.settings, { title: 'Goal task', directory: '/wrong', workingDirectories: state.goals[0].workingDirectories, goalId: state.goals[0].id })
    expect(task.directory).toBe('/projects/primary')
    expect(task.workingDirectories).toEqual(['/projects/primary', '/research/data'])
  })
})

describe('optimistic goal workspace rollback', () => {
  it('restores all task workspace fields after a failed goal save, including a later detach', () => {
    const { state, task } = fixture()
    const before = migrateWorkingDirectories(state)
    const applied = applyGoalWorkingDirectories(before, state.goals[0].id, ['/failed/primary', '/failed/data'])
    expect(applied.tasks[0]).toMatchObject({ directory: '/failed/primary', workingDirectories: ['/failed/primary', '/failed/data'] })
    const restored = rollbackGoalAssistantAction(applied, before, applied)
    expect(restored.goals[0].workingDirectories).toEqual(before.goals[0].workingDirectories)
    expect(restored.tasks[0]).toStrictEqual(before.tasks[0])
    const detached = linkTaskToGoal(restored, task.id)
    expect(getTaskWorkingDirectories(detached, detached.tasks[0])).toEqual(before.tasks[0].workingDirectories)
    expect(rollbackGoalAssistantAction(restored, before, applied)).toBe(restored)
  })

  it('preserves concurrent native turns, recovered history and unrelated edits while rolling back only failed workspace fields', () => {
    const { state, task } = fixture()
    const before = { ...state, tasks: [createWorkspaceTask(state.settings, { title: task.title, goalId: task.goalId, workingDirectories: state.goals[0].workingDirectories })] }
    const applied = applyGoalWorkingDirectories(before, state.goals[0].id, ['/failed/primary'])
    expect(applied.tasks[0].legacyArtifactDirectory).toBe('/projects/primary')
    const member = before.tasks[0].members[0]
    const concurrentTask = { ...applied.tasks[0], historyPending: true, title: 'Concurrent rename', messages: [{ id: 'native-message', role: 'assistant' as const, text: 'Already received streaming content', createdAt: task.createdAt }], events: [{ id: 'native-event', taskId: applied.tasks[0].id, runId: 'concurrent-turn', memberId: member.id, kind: 'stdout' as const, text: 'native event', timestamp: task.createdAt }], runs: [{ id: 'concurrent-turn', directory: '/failed/primary', workingDirectories: ['/failed/primary'], createdAt: task.createdAt, prompt: 'Started before the save acknowledgement', members: [{ ...member, runtime: before.settings.runtimes[0], model: '', status: 'running' as const, sessionId: 'native-session' }] }] }
    const current = { ...applied, tasks: [concurrentTask], settings: { ...applied.settings, maxParallel: 6 } }
    const restored = rollbackGoalAssistantAction(current, before, applied)
    expect(restored.tasks[0]).toMatchObject({ directory: '/projects/primary', workingDirectories: ['/projects/primary', '/research/data'], historyPending: true, title: 'Concurrent rename' })
    expect(Object.hasOwn(restored.tasks[0], 'legacyArtifactDirectory')).toBe(false)
    for (const key of ['runs', 'messages', 'events', 'members'] as const) expect(restored.tasks[0][key]).toBe(concurrentTask[key])
    expect(restored.tasks[0].runs[0].directory).toBe('/failed/primary')
    expect(restored.settings).toBe(current.settings)
  })

  it('does not replace a workspace or historical base changed by a later independent action', () => {
    const { state } = fixture()
    const before = migrateWorkingDirectories(state)
    const applied = applyGoalWorkingDirectories(before, state.goals[0].id, ['/failed/primary'])
    const current = applyGoalWorkingDirectories(applied, state.goals[0].id, ['/later/primary', '/later/data'])
    current.tasks = current.tasks.map(task => ({ ...task, legacyArtifactDirectory: '/later/historical-base' }))
    const restored = rollbackGoalAssistantAction(current, before, applied)
    expect(restored.goals[0].workingDirectories).toEqual(['/later/primary', '/later/data'])
    expect(restored.tasks[0]).toBe(current.tasks[0])
    expect(restored.tasks[0].legacyArtifactDirectory).toBe('/later/historical-base')
  })
})
