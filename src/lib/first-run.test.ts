import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { createGoal } from './goals'
import { acceptanceItems, discoveredRuntimeNames, firstPendingAcceptance, firstRunGoalId, firstRunTemplates, prepareFirstRunDraft, runtimeReadyForExecution } from './first-run'
import { createWorkspaceTask } from './workspace'
import type { GoalAssistantDraft } from './goal-types'
import type { LocalDiscoveryReport } from './types'

const draft = (patch: Partial<GoalAssistantDraft> = {}): GoalAssistantDraft => ({
  title: 'Ship the first task', intent: '', expected: 'A new user finishes', constraints: '', deadline: '', currentSummary: '',
  criteria: [{ text: 'The first task completes', baseline: '', target: '', method: '' }],
  ...patch,
})

describe('first-run helpers', () => {
  it('keeps a few concrete templates in both languages', () => {
    expect(firstRunTemplates).toHaveLength(4)
    expect(new Set(firstRunTemplates.map(item => item.id)).size).toBe(4)
    for (const template of firstRunTemplates) {
      expect(template.label[0].trim()).not.toBe('')
      expect(template.label[1].trim()).not.toBe('')
      expect(template.prompt[0].trim()).not.toBe('')
      expect(template.prompt[1].trim()).not.toBe('')
      expect(template.prompt[0]).not.toBe(template.prompt[1])
    }
  })

  it('resumes clarification only for the remembered unconfirmed goal', () => {
    const state = createInitialState()
    const goal = createGoal({ title: 'First idea' })
    state.goals = [goal]
    expect(firstRunGoalId(state, null)).toBeNull()
    expect(firstRunGoalId(state, goal.id)).toBe(goal.id)
    state.goals = [{ ...goal, status: 'active' }]
    expect(firstRunGoalId(state, goal.id)).toBeNull()
    state.goals = [{ ...goal, assistant: { confirmedVersion: 1 } }]
    expect(firstRunGoalId(state, goal.id)).toBeNull()
    state.goals = [goal, createGoal({ title: 'Second goal' })]
    expect(firstRunGoalId(state, goal.id)).toBeNull()
  })

  it('treats starter placeholders as not ready to execute', () => {
    const state = createInitialState()
    expect(runtimeReadyForExecution(state)).toBe(false)
    state.onboarding = { version: 1, completedAt: '2026-10-21T00:00:00Z', outcome: 'deferred' }
    expect(runtimeReadyForExecution(state)).toBe(false)
    state.onboarding = { ...state.onboarding, outcome: 'configured' }
    expect(runtimeReadyForExecution(state)).toBe(true)
    state.settings = { ...state.settings, runtimes: state.settings.runtimes.map(runtime => ({ ...runtime, enabled: false })) }
    expect(runtimeReadyForExecution(state)).toBe(false)
  })

  it('fills verification defaults for a one-line criterion and keeps an explicit method', () => {
    const prepared = prepareFirstRunDraft(draft())
    expect(prepared.criteria[0]).toMatchObject({ text: 'The first task completes', target: 'The first task completes', method: '在目标卡片上核对这项结果' })
    const explicit = prepareFirstRunDraft(draft({ criteria: [{ text: 'Checks pass', baseline: 'none', target: 'CI green', method: 'Read the log' }] }))
    expect(explicit.criteria[0]).toMatchObject({ target: 'CI green', method: 'Read the log' })
    expect(prepareFirstRunDraft(draft({ criteria: [{ text: '  ', baseline: '', target: '', method: '' }] })).criteria).toEqual([])
  })

  it('names usable discovered runtimes and ignores generic adapters', () => {
    const report: LocalDiscoveryReport = { scannedAt: '2026-10-21T00:00:00Z', runtimes: [
      { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', probe: { found: true, path: '/bin/codex', version: '1' }, models: [], configSources: [], warnings: [] },
      { id: 'claude', name: 'Claude Code', executable: 'claude', adapter: 'claude', probe: { found: false, path: '', version: '' }, models: [], configSources: [], warnings: [] },
      { id: 'deepseek-harness', name: 'DeepSeek Harness', executable: 'dsh', adapter: 'generic', probe: { found: true, path: '/bin/dsh', version: '1' }, models: [], configSources: [], warnings: [] },
    ] }
    expect(discoveredRuntimeNames(report)).toEqual(['Codex'])
    expect(discoveredRuntimeNames(null)).toEqual([])
  })

  it('returns the first submitted result and hides the card after any acceptance', () => {
    const state = createInitialState()
    const goal = createGoal({ title: 'Ship', expected: 'Done', criteria: ['Checks pass'] })
    const task = createWorkspaceTask(state.settings, { title: 'First task', goalId: goal.id, acceptance: 'Checks pass' })
    task.results = [{ id: 'result-1', summary: 'Draft', evidence: 'notes', createdAt: '2026-10-21T00:00:00Z', verdict: 'submitted', requirementsVersion: 0 }]
    state.tasks = [task]
    expect(firstPendingAcceptance(state, goal.id)?.result.id).toBe('result-1')
    expect(acceptanceItems(task, goal)).toEqual(['Checks pass'])
    task.acceptance = 'Can reproduce\nNames the file'
    expect(acceptanceItems(task, goal)).toEqual(['Can reproduce', 'Names the file'])
    task.results = [{ ...task.results[0], verdict: 'accepted', reviewNote: 'Checked' }]
    expect(firstPendingAcceptance(state, goal.id)).toBeUndefined()
  })
})
