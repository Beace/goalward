import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal, reviseGoal, setGoalStatus, updateCriterion, updateGoalState } from './goals'
import { captureRunContext, migrateWorkspace } from './workspace'
import { StatePersistence } from './state-persistence'
import type { AppState, Run } from './types'
import type { GoalAssistantDraft, GoalTaskProposal } from './goal-types'
import { adoptGoalTaskProposal, adoptGoalTaskProposals, confirmGoalAssistantDraft, createGoalAssistantTask, dismissGoalTaskProposal, goalAssistantPrompt, goalAssistantRuntime, parseGoalAssistantResponse, processGoalAssistantRun, rollbackGoalAssistantAction, validateGoalAssistantDate, validateGoalTaskProposals } from './goal-assistant'

const draft: GoalAssistantDraft = { title: '形成可以验证的方案', intent: '减少后续返工', expected: '完成一个可试用方案并明确限制', constraints: '只处理已约定范围', deadline: '2026-10-30', currentSummary: '现有实现尚待调查', criteria: [{ text: '可试用方案', baseline: '尚无验证', target: '主要流程通过试用', method: '演示约定流程并保存检查记录' }] }
const block = (action: unknown) => `可读回复。\n\n\`\`\`goalward\n${JSON.stringify(action)}\n\`\`\``
const planInput = (overrides: Record<string, unknown> = {}) => ({ id: 'investigate', title: '调查边界', delivery: '边界与未知清单', acceptance: '清单覆盖约定模块并标记未知', deadline: '2026-10-20', dependsOn: [], ...overrides })
function stateWithGoal(): AppState {
  const state = createInitialState()
  const goal = createGoal({ title: '我想改善这个产品' })
  return { ...state, goals: [{ ...goal, assistant: { input: goal.title } }] }
}
function responseState(response: string, phase: 'clarify' | 'plan' = 'clarify') {
  let state = stateWithGoal()
  if (phase === 'plan') state = confirmGoalAssistantDraft(state, state.goals[0].id, draft)
  let goal = state.goals[0]
  const task = createGoalAssistantTask(state.settings, { goalId: goal.id, directory: '/app/goal-workspace' })
  goal = { ...goal, assistant: { ...goal.assistant, taskId: task.id, requestPhase: phase } }
  state = { ...state, goals: [goal], tasks: [...state.tasks, task] }
  const run: Run = { id: 'run-assistant', createdAt: '2026-10-10T00:00:00Z', directory: task.directory, prompt: '帮助我澄清', context: captureRunContext(state, task), members: [{ ...task.members[0], runtime: goalAssistantRuntime(state.settings.runtimes[0]), model: '', status: 'completed' }] }
  state = { ...state, tasks: state.tasks.map(item => item.id === task.id ? { ...item, runs: [run], messages: [{ id: 'reply', role: 'assistant', text: response.replaceAll('VERSION', String(goal.version)), runId: run.id, createdAt: run.createdAt }] } : item) }
  return { state, goal, task, run }
}
describe('untrusted assistant action parsing', () => {
  it('accepts a single final action and derives statuses and source versions itself', () => {
    const action = parseGoalAssistantResponse(block({ type: 'clarify', baseGoalVersion: 1, draft }), 1, 'clarify')
    expect(action.draft).toEqual(draft)
    const planning = parseGoalAssistantResponse(block({ type: 'plan', baseGoalVersion: 2, proposals: [planInput()] }), 2, 'plan', draft.deadline)
    expect(planning.proposals?.[0]).toMatchObject({ status: 'suggested', baseGoalVersion: 2 })
    expect(parseGoalAssistantResponse(block({ type: 'clarify', baseGoalVersion: 1, draft: null }), 1).draft).toBeUndefined()
  })
  it('rejects ambiguous blocks, trailing text, malformed JSON and model-owned acceptance state', () => {
    const valid = block({ type: 'clarify', baseGoalVersion: 1, draft })
    for (const value of ['no action', `${valid}\nextra`, `${valid}\n${valid}`, '```goalward\n{invalid}\n```', block({ type: 'clarify', baseGoalVersion: 1, draft, status: 'achieved' }), block({ type: 'clarify', baseGoalVersion: 1, draft: { ...draft, criteria: [{ ...draft.criteria[0], status: 'satisfied', evidence: 'claimed success' }] } }), block({ type: 'plan', baseGoalVersion: 1, proposals: [planInput({ status: 'adopted', taskId: 'injected' })] }), block({ type: 'plan', baseGoalVersion: 1, proposals: [planInput({ edited: true })] })]) {
      expect(() => parseGoalAssistantResponse(value, 1)).toThrow()
    }
  })
  it('rejects stale sources and phase mismatches rather than treating them as success', () => {
    expect(() => parseGoalAssistantResponse(block({ type: 'clarify', baseGoalVersion: 2, draft }), 1)).toThrow('版本')
    expect(() => parseGoalAssistantResponse(block({ type: 'clarify', baseGoalVersion: 1, draft }), 1, 'plan')).toThrow('请求')
    expect(() => parseGoalAssistantResponse(block({ type: 'clarify', baseGoalVersion: 1, draft: { ...draft, criteria: [] } }), 1)).toThrow('完成标准')
  })
  it('validates real calendar dates without inventing a timezone or deadline time', () => {
    expect(validateGoalAssistantDate('')).toBe('')
    expect(validateGoalAssistantDate('2028-02-29')).toBe('2028-02-29')
    for (const value of ['2026-02-29', '2026-13-01', '2026-04-31', '10/20/2026', '2026-10-20T23:59:00Z', '0000-01-01']) expect(() => validateGoalAssistantDate(value)).toThrow()
  })
  it('rejects duplicate IDs, unknown dependencies, dependency cycles and impossible dates', () => {
    const values = [
      [planInput(), planInput()],
      [planInput({ dependsOn: ['missing'] })],
      [planInput({ dependsOn: ['build'] }), planInput({ id: 'build', dependsOn: ['investigate'] })],
      [planInput({ deadline: '2026-10-31' })],
      [planInput(), planInput({ id: 'build', deadline: '2026-10-19', dependsOn: ['investigate'] })],
    ]
    values.forEach(proposals => expect(() => parseGoalAssistantResponse(block({ type: 'plan', baseGoalVersion: 1, proposals }), 1, 'plan', draft.deadline)).toThrow())
  })
})
describe('real Runtime results remain suggestions', () => {
  it('only processes a successful latest assistant Run once and preserves the immutable Run context', () => {
    const fixture = responseState(block({ type: 'clarify', baseGoalVersion: 'VERSION', draft }))
    // The mock source version is a number in the actual final reply.
    fixture.state.tasks.find(item => item.id === fixture.task.id)!.messages[0].text = block({ type: 'clarify', baseGoalVersion: fixture.goal.version, draft })
    const before = JSON.stringify(fixture.state.tasks.find(item => item.id === fixture.task.id)!.runs[0].context)
    const next = processGoalAssistantRun(fixture.state, fixture.goal.id, fixture.run.id)
    expect(next.goals[0].assistant?.draft).toEqual(draft)
    expect(next.goals[0].assistant).toMatchObject({ draftGoalVersion: fixture.goal.version, draftStateVersion: fixture.goal.currentState.version })
    expect(next.goals[0].assistant?.confirmedVersion).toBeUndefined()
    expect(next.goals[0].status).toBe('clarifying')
    expect(next.tasks).toBe(fixture.state.tasks)
    expect(JSON.stringify(next.tasks.find(item => item.id === fixture.task.id)!.runs[0].context)).toBe(before)
    expect(processGoalAssistantRun(next, fixture.goal.id, fixture.run.id)).toBe(next)
  })
  it('does not use running, failed, stopped, interrupted, streaming or unhydrated replies', () => {
    const fixture = responseState(block({ type: 'clarify', baseGoalVersion: 1, draft }))
    for (const status of ['running', 'failed', 'stopped', 'interrupted'] as const) {
      const state = { ...fixture.state, tasks: fixture.state.tasks.map(item => item.id === fixture.task.id ? { ...item, runs: [{ ...fixture.run, members: fixture.run.members.map(item => ({ ...item, status })) }] } : item) }
      expect(processGoalAssistantRun(state, fixture.goal.id, fixture.run.id)).toBe(state)
    }
    const unhydrated = { ...fixture.state, tasks: fixture.state.tasks.map(item => item.id === fixture.task.id ? { ...item, historyPending: true } : item) }
    expect(processGoalAssistantRun(unhydrated, fixture.goal.id, fixture.run.id)).toBe(unhydrated)
    const streaming = { ...fixture.state, tasks: fixture.state.tasks.map(item => item.id === fixture.task.id ? { ...item, messages: item.messages.map(item => ({ ...item, streaming: true })) } : item) }
    expect(processGoalAssistantRun(streaming, fixture.goal.id, fixture.run.id).goals[0].assistant?.draft).toBeUndefined()
  })
  it('preserves edits made while replying and records format errors for explicit retry', () => {
    const fixture = responseState(block({ type: 'clarify', baseGoalVersion: 1, draft }))
    const edited = { ...fixture.state, goals: [{ ...fixture.goal, assistant: { ...fixture.goal.assistant, draft: { ...draft, title: '我已修改' } } }] }
    const kept = processGoalAssistantRun(edited, fixture.goal.id, fixture.run.id)
    expect(kept.goals[0].assistant?.draft?.title).toBe('我已修改')
    expect(kept.goals[0].assistant?.error).toContain('修改')
    const broken = responseState('正常完成了对话，但没有有效的 action。')
    const result = processGoalAssistantRun(broken.state, broken.goal.id, broken.run.id)
    expect(result.goals[0].assistant?.error).toContain('goalward')
    expect(result.goals[0].assistant?.processedRunId).toBe(broken.run.id)
    expect(processGoalAssistantRun(result, broken.goal.id, broken.run.id)).toBe(result)
  })
  it('does not let a stale goal Run modify the revised goal', () => {
    const fixture = responseState(block({ type: 'clarify', baseGoalVersion: 1, draft }))
    const newer = { ...fixture.state, goals: [{ ...fixture.goal, version: 2 }] }
    const next = processGoalAssistantRun(newer, fixture.goal.id, fixture.run.id)
    expect(next.goals[0].assistant?.draft).toBeUndefined()
    expect(next.goals[0].assistant?.error).toContain('修订')
  })
  it('does not publish a draft from before a manual summary update', () => {
    const fixture = responseState(block({ type: 'clarify', baseGoalVersion: 1, draft }))
    const newerGoal = updateGoalState(fixture.goal, { summary: '用户更新的真实现状', reason: '发现新情况' })
    const next = processGoalAssistantRun({ ...fixture.state, goals: [newerGoal] }, fixture.goal.id, fixture.run.id)
    expect(next.goals[0].assistant?.draft).toBeUndefined()
    expect(next.goals[0].assistant?.error).toContain('现状已更新')
    expect(next.goals[0].currentState.summary).toBe('用户更新的真实现状')
  })
  function retryState(incoming: Array<ReturnType<typeof planInput>>, existing: (version: number) => GoalTaskProposal[]) {
    const fixture = responseState('', 'plan'), proposals = existing(fixture.goal.version)
    const goal = { ...fixture.goal, assistant: { ...fixture.goal.assistant, proposals } }
    const run = { ...fixture.run, context: { ...fixture.run.context!, goal: structuredClone(goal) } }
    const state = { ...fixture.state, goals: [goal], tasks: fixture.state.tasks.map(task => task.id === fixture.task.id ? { ...task, runs: [run], messages: [{ ...task.messages[0], text: block({ type: 'plan', baseGoalVersion: goal.version, proposals: incoming }) }] } : task) }
    return { ...fixture, goal, state }
  }
  it('keeps user-edited suggestions while replacing untouched ones and adds valid new dependencies', () => {
    const fixture = retryState([planInput({ title: '模型重写旧任务' }), planInput({ id: 'build', deadline: '2026-10-25', dependsOn: ['investigate'] })], version => [
      { ...planInput({ title: '用户编辑的名称', delivery: '用户选择的交付', acceptance: '人工指定标准' }), edited: true, status: 'suggested', baseGoalVersion: version },
      { ...planInput({ id: 'obsolete' }), status: 'suggested', baseGoalVersion: version },
    ])
    expect(goalAssistantPrompt(fixture.goal, 'plan')).toContain('用户编辑的名称')
    const next = processGoalAssistantRun(fixture.state, fixture.goal.id, fixture.run.id)
    expect(next.goals[0].assistant?.error).toBeUndefined()
    expect(next.goals[0].assistant?.proposals).toHaveLength(2)
    expect(next.goals[0].assistant?.proposals?.[0]).toEqual(fixture.goal.assistant.proposals![0])
    expect(next.goals[0].assistant?.proposals?.[1]).toMatchObject({ id: 'build', dependsOn: ['investigate'] })
    expect(next.goals[0].assistant?.proposals?.some(item => item.id === 'obsolete')).toBe(false)
  })
  it('keeps the original plan and reports errors if preserved edits make merged dependencies or dates invalid', () => {
    for (const invalid of ['missing', 'date'] as const) {
      const fixture = retryState([planInput({ id: 'build', deadline: '2026-10-22', dependsOn: invalid === 'date' ? ['investigate'] : [] })], version => [
        { ...planInput({ title: '不可丢的手改任务', deadline: invalid === 'date' ? '2026-10-28' : '2026-10-20', dependsOn: invalid === 'missing' ? ['previous'] : [] }), edited: true, status: 'suggested', baseGoalVersion: version },
        ...(invalid === 'missing' ? [{ ...planInput({ id: 'previous' }), status: 'suggested' as const, baseGoalVersion: version }] : []),
      ])
      const next = processGoalAssistantRun(fixture.state, fixture.goal.id, fixture.run.id)
      expect(next.goals[0].assistant?.proposals).toEqual(fixture.goal.assistant.proposals)
      expect(next.goals[0].assistant?.error).toBeTruthy()
      expect(next.goals[0].assistant?.processedRunId).toBe(fixture.run.id)
    }
  })
})
describe('explicit confirmation and task adoption', () => {
  function proposedState() {
    const initial = stateWithGoal()
    const confirmed = confirmGoalAssistantDraft(initial, initial.goals[0].id, draft)
    const goal = confirmed.goals[0]
    const proposals: GoalTaskProposal[] = [
      { ...planInput(), status: 'suggested', baseGoalVersion: goal.version },
      { ...planInput({ id: 'build', title: '制作方案', deadline: '2026-10-25', dependsOn: ['investigate'] }), status: 'suggested', baseGoalVersion: goal.version } as GoalTaskProposal,
    ]
    return { ...confirmed, goals: [{ ...goal, assistant: { ...goal.assistant, proposals } }] }
  }
  it('confirms a draft without achieving the goal and is idempotent on repeated confirmation', () => {
    const state = stateWithGoal()
    const next = confirmGoalAssistantDraft(state, state.goals[0].id, draft)
    expect(next.goals[0]).toMatchObject({ expected: draft.expected, deadline: draft.deadline, status: 'active' })
    expect(next.goals[0].criteria[0]).toMatchObject({ ...draft.criteria[0], status: 'unverified', evidence: '' })
    expect(next.goals[0].definitions[0].title).toBe(state.goals[0].title)
    expect(next.goals[0].assistant?.confirmedVersion).toBe(next.goals[0].version)
    expect(confirmGoalAssistantDraft(next, state.goals[0].id, draft)).toBe(next)
  })
  it('adopts the complete plan transactionally, maps dependencies and never starts processes', () => {
    const state = proposedState()
    const next = adoptGoalTaskProposals(state, state.goals[0].id)
    const suggestions = next.goals[0].assistant!.proposals!
    const first = next.tasks.find(item => item.id === suggestions[0].taskId)!
    const second = next.tasks.find(item => item.id === suggestions[1].taskId)!
    expect(first).toMatchObject({ delivery: '边界与未知清单', deadline: '2026-10-20', businessStatus: 'todo', requirementsVersion: 0, runs: [], results: [] })
    expect(second.dependencies).toEqual([first.id])
    expect(next.goals[0].criteria[0].status).toBe('unverified')
    expect(adoptGoalTaskProposals(next, state.goals[0].id)).toBe(next)
    expect(adoptGoalTaskProposal(next, state.goals[0].id, suggestions[0].id)).toBe(next)
  })
  it('requires prerequisites and matching goal versions, and dismissal keeps dependencies consistent', () => {
    const state = proposedState(), id = state.goals[0].id
    expect(() => adoptGoalTaskProposal(state, id, 'build')).toThrow('前置')
    expect(() => dismissGoalTaskProposal(state, id, 'investigate')).toThrow('依赖')
    const first = adoptGoalTaskProposal(state, id, 'investigate')
    expect(adoptGoalTaskProposal(first, id, 'build').tasks).toHaveLength(state.tasks.length + 2)
    const changed = { ...state, goals: [{ ...state.goals[0], version: 3 }] }
    expect(() => adoptGoalTaskProposals(changed, id)).toThrow('最新目标')
    const dismissed = dismissGoalTaskProposal(state, id, 'build')
    expect(dismissed.goals[0].assistant!.proposals![1].status).toBe('dismissed')
  })
  it('keeps adopted source history as a dependency when the confirmed goal is revised', () => {
    const initial = proposedState(), adopted = adoptGoalTaskProposal(initial, initial.goals[0].id, 'investigate'), original = adopted.goals[0]
    const revised = confirmGoalAssistantDraft(adopted, original.id, { ...draft, title: '修订后的范围' })
    const goal = revised.goals[0], previous = goal.assistant!.proposals![0]
    const state = { ...revised, goals: [{ ...goal, assistant: { ...goal.assistant, proposals: [previous, { ...goal.assistant!.proposals![1], baseGoalVersion: goal.version }] } }] }
    const next = adoptGoalTaskProposal(state, goal.id, 'build')
    expect(next.goals[0].assistant!.proposals![0]).toEqual(previous)
    expect(previous.baseGoalVersion).toBe(original.version)
    expect(next.tasks.find(task => task.id === next.goals[0].assistant!.proposals![1].taskId)?.dependencies).toEqual([previous.taskId])
    expect(next.tasks.find(task => task.id === previous.taskId)).toEqual(adopted.tasks.find(task => task.id === previous.taskId))
  })
  it('invalidates acceptance after outcome or verification changes while archiving evidence', () => {
    let goal = createGoal({ title: draft.title, expected: draft.expected, criteria: draft.criteria })
    goal = updateCriterion(goal, goal.criteria[0].id, 'satisfied', '用户验证记录')
    goal = setGoalStatus(goal, 'achieved')
    const context = structuredClone(goal)
    for (const change of [{ expected: '新的预期', criteria: draft.criteria }, { expected: draft.expected, criteria: [{ ...draft.criteria[0], method: '新的验证方法' }] }]) {
      const next = reviseGoal(goal, { ...draft, ...change, reason: '用户改变验收范围' })
      expect(next.criteria[0]).toMatchObject({ status: 'unverified', evidence: '' })
      expect(next.status).toBe('active')
      expect(next.definitions[0].criteria[0].evidence).toBe('用户验证记录')
      expect(goal).toEqual(context)
    }
  })
  it('rolls back a failed confirmation while preserving concurrent input, tasks and settings', () => {
    const before = stateWithGoal(), applied = confirmGoalAssistantDraft(before, before.goals[0].id, draft)
    const current = { ...applied, settings: { ...applied.settings, maxParallel: 5 }, goals: [{ ...applied.goals[0], assistant: { ...applied.goals[0].assistant, input: '回复期间的新输入' } }] }
    const restored = rollbackGoalAssistantAction(current, before, applied)
    expect(restored.goals[0]).toMatchObject({ title: before.goals[0].title, version: before.goals[0].version, status: 'clarifying' })
    expect(restored.goals[0].assistant).toEqual({ input: '回复期间的新输入' })
    expect(restored.settings.maxParallel).toBe(5)
    expect(restored.tasks).toEqual(current.tasks)
    expect(confirmGoalAssistantDraft(restored, before.goals[0].id, draft).goals[0].assistant?.confirmedVersion).toBe(applied.goals[0].version)
    expect(rollbackGoalAssistantAction(restored, before, applied)).toBe(restored)
  })
  it('removes only unused tasks from a failed adoption and preserves started work and its linkage', () => {
    const before = proposedState(), applied = adoptGoalTaskProposals(before, before.goals[0].id)
    expect(rollbackGoalAssistantAction(applied, before, applied)).toEqual(before)
    const taskId = applied.goals[0].assistant!.proposals![0].taskId!
    const current = { ...applied, tasks: applied.tasks.map(task => task.id === taskId ? { ...task, messages: [{ id: 'concurrent', role: 'user' as const, text: '已开始的任务', createdAt: '2026-10-10T00:00:00Z' }] } : task) }
    const restored = rollbackGoalAssistantAction(current, before, applied)
    expect(restored.tasks.find(task => task.id === taskId)?.messages[0].text).toBe('已开始的任务')
    expect(restored.tasks).toHaveLength(before.tasks.length + 1)
    expect(restored.goals[0].assistant!.proposals!.find(item => item.id === 'investigate')).toMatchObject({ status: 'adopted', taskId })
    expect(restored.goals[0].assistant!.proposals!.find(item => item.id === 'build')?.status).toBe('suggested')
    expect(before.goals[0].assistant!.proposals![0].status).toBe('suggested')
  })
  it('restores a failed new-goal action and exploration input without discarding later edits', () => {
    const before = { ...stateWithGoal(), goalExplorationInput: '尚未提交的想法' }, newGoal = createGoal({ title: before.goalExplorationInput })
    const applied = { ...before, goals: [...before.goals, newGoal], activeGoalId: newGoal.id, goalExplorationInput: '' }
    expect(rollbackGoalAssistantAction(applied, before, applied)).toEqual(before)
    const current = { ...applied, goalExplorationInput: '新的想法', goals: [...before.goals, { ...newGoal, intent: '并发补充' }] }
    const restored = rollbackGoalAssistantAction(current, before, applied)
    expect(restored.goals.at(-1)?.intent).toBe('并发补充')
    expect(restored.goalExplorationInput).toBe('新的想法')
  })
  it('invalidates a stale draft after formal revisions and rejects its captured source or unversioned retry', () => {
    const state = proposedState(), original = state.goals[0]
    const source = { goalVersion: original.version, stateVersion: original.currentState.version }
    const revised = reviseGoal(original, { ...draft, title: '用户修订的新名称', expected: '用户修订的新结果', deadline: '2026-11-05', criteria: draft.criteria, reason: '明确新的交付范围' })
    expect(revised.assistant?.draft).toBeUndefined()
    expect(revised.assistant?.proposals).toBe(original.assistant?.proposals)
    expect(revised.assistant?.input).toBe(original.assistant?.input)
    const next = { ...state, goals: [revised] }
    expect(() => confirmGoalAssistantDraft(next, revised.id, draft, source)).toThrow('已更新')
    expect(() => confirmGoalAssistantDraft(next, revised.id, draft)).toThrow('已更新')
    const currentDraft = { ...draft, title: revised.title, expected: revised.expected, deadline: revised.deadline }
    const reconfirmed = confirmGoalAssistantDraft(next, revised.id, currentDraft, { goalVersion: revised.version, stateVersion: revised.currentState.version })
    expect(reconfirmed.goals[0]).toMatchObject({ title: revised.title, expected: revised.expected, deadline: revised.deadline })
    expect(reconfirmed.goals[0].assistant?.draftGoalVersion).toBe(reconfirmed.goals[0].version)
    expect(reconfirmed.tasks).toBe(state.tasks)
    expect(revised.definitions.at(-1)?.title).toBe('用户修订的新名称')
  })
  it('invalidates legacy drafts on changed summary but preserves draft content on an unchanged summary', () => {
    const state = proposedState(), original = state.goals[0]
    const legacy = { ...original, assistant: { ...original.assistant, draftGoalVersion: undefined, draftStateVersion: undefined } }
    const updated = updateGoalState(legacy, { summary: '用户补充的新现状', reason: '情况变化' })
    expect(updated.assistant?.draft).toBeUndefined()
    expect(updated.assistant?.draftStateVersion).toBe(legacy.currentState.version)
    expect(updated.assistant?.proposals).toBe(legacy.assistant?.proposals)
    expect(() => confirmGoalAssistantDraft({ ...state, goals: [updated] }, updated.id, draft)).toThrow('已更新')
    const source = { goalVersion: original.version, stateVersion: original.currentState.version }
    expect(() => confirmGoalAssistantDraft({ ...state, goals: [updated] }, updated.id, draft, source)).toThrow('已更新')
    const identical = updateGoalState(original, { summary: original.currentState.summary, reason: '现状条目补充' })
    expect(identical.assistant?.draft).toEqual(draft)
    expect(identical.assistant?.draftStateVersion).toBe(identical.currentState.version)
    const reconfirmed = confirmGoalAssistantDraft({ ...state, goals: [updated] }, updated.id, { ...draft, currentSummary: updated.currentState.summary }, { goalVersion: updated.version, stateVersion: updated.currentState.version })
    expect(reconfirmed.goals[0].currentState.summary).toBe('用户补充的新现状')
    expect(reconfirmed.goals[0].assistant?.draftStateVersion).toBe(reconfirmed.goals[0].currentState.version)
    expect(updated.stateHistory.at(-1)?.summary).toBe('用户补充的新现状')
  })
})
describe('additive state and limited assistant Runtime settings', () => {
  it('round-trips legacy workspace metadata and new assistant fields without dropping history', () => {
    const state = stateWithGoal()
    const legacy = migrateWorkspace(JSON.parse(JSON.stringify(state)))
    expect(legacy.tasks).toEqual(state.tasks)
    const task = createGoalAssistantTask(state.settings, { goalId: state.goals[0].id, directory: '/app/goal-workspace' })
    const extended = { ...legacy, goals: [{ ...legacy.goals[0], assistant: { taskId: task.id, draft, confirmedVersion: 1 } }], tasks: [...legacy.tasks, { ...task, delivery: '目标草案', deadline: draft.deadline, requirementsVersion: 2 }] }
    const persistence = new StatePersistence()
    persistence.loaded(legacy)
    const restored = migrateWorkspace(JSON.parse(JSON.stringify(persistence.prepare(extended))))
    expect(restored.goals[0].assistant?.draft).toEqual(draft)
    expect(restored.tasks.at(-1)).toMatchObject({ kind: 'goal_assistant', deadline: draft.deadline, requirementsVersion: 2 })
    expect(restored.tasks[0].runs).toEqual(legacy.tasks[0].runs)
  })
  it('uses a private conversation task without modifying settings or granting project writes', () => {
    const state = stateWithGoal(), snapshot = structuredClone(state.settings)
    const task = createGoalAssistantTask(state.settings, { goalId: state.goals[0].id, directory: '/app/goal-workspace' })
    expect(task).toMatchObject({ kind: 'goal_assistant', mode: 'solo', goalId: state.goals[0].id, runs: [] })
    expect(goalAssistantRuntime(state.settings.runtimes[0]).permissions?.codex).toEqual({ sandbox: 'read-only', network: 'inherit', additionalDirectories: [] })
    const pi = goalAssistantRuntime({ ...state.settings.runtimes.find(item => item.id === 'pi')!, enabled: true })
    expect(pi.args).toContain('--no-tools')
    expect(state.settings).toEqual(snapshot)
    expect(() => goalAssistantRuntime({ ...state.settings.runtimes[0], adapter: 'generic' })).toThrow('通用 CLI')
    expect(() => createGoalAssistantTask(state.settings, { goalId: '../project', directory: '/app/goal-workspace' })).toThrow('标识')
    expect(goalAssistantPrompt(state.goals[0], 'clarify', '原始想法')).toContain('draft 设为 null')
    expect(goalAssistantPrompt(state.goals[0], 'plan')).toContain('不得修改用户项目')
  })
  it('validates edited task suggestions before adoption', () => {
    const invalid: GoalTaskProposal = { ...planInput(), status: 'suggested', baseGoalVersion: 1, deadline: '2026-10-31' }
    expect(() => validateGoalTaskProposals([invalid], { version: 1, deadline: draft.deadline })).toThrow('DDL')
  })
})
