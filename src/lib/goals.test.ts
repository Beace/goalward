import { describe, expect, it } from 'vitest'
import { acceptGoalProposal, createDueGoalReview, createGoal, createStateEntry, dueReviewPeriod, proposeGoalState, rebaseGoalProposal, reviseGoal, saveGoalReview, setGoalStatus, updateCriterion, updateGoalState } from './goals'

const createdAt = '2026-09-14T00:00:00.000Z'
const source = { kind: 'task' as const, label: 'Research result accepted by the user', taskId: 'task-1', runId: 'run-1', reference: '/tmp/research.md' }

describe('goal definitions and success conditions', () => {
  it('creates an unseeded goal from only a user description, without Runtime or metric prerequisites', () => {
    const goal = createGoal({ title: '  Research a feasible option  ' }, createdAt)
    expect(goal.title).toBe('Research a feasible option')
    expect(goal.status).toBe('clarifying')
    expect(goal.criteria).toEqual([])
    expect(goal.currentState.entries).toEqual([])
    expect(goal.currentState.summary).toBe('')
    expect(goal.reviews).toEqual([])
    expect(goal.definitions[0].title).toBe(goal.title)
    expect(() => createGoal({ title: ' ' })).toThrow('请先描述')
  })

  it('requires explicit success evidence and invalidates achievement after a changed criterion', () => {
    let goal = createGoal({ title: 'Deliver a desktop tool', expected: 'Ready for trial', criteria: ['Installation package passes the trial'] }, createdAt)
    expect(() => setGoalStatus(goal, 'achieved')).toThrow('逐项确认')
    expect(() => updateCriterion(goal, goal.criteria[0].id, 'satisfied', '')).toThrow('验收依据')
    goal = updateCriterion(goal, goal.criteria[0].id, 'satisfied', 'The user checked installation and main workflows')
    const achieved = setGoalStatus(goal, 'achieved')
    expect(achieved.status).toBe('achieved')
    const revised = reviseGoal(achieved, { title: achieved.title, intent: '', expected: 'Team can try it', constraints: 'Offline use', deadline: '', criteria: ['Installation package passes the trial', 'Offline workflow works'], reason: 'Add offline requirements' })
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('active')
    expect(revised.criteria.map(criterion => criterion.status)).toEqual(['unverified', 'unverified'])
    expect(revised.definitions[0].criteria[0].evidence).toBe('The user checked installation and main workflows')
    expect(revised.definitions[0].expected).toBe('Ready for trial')
    expect(achieved.criteria).toHaveLength(1)
  })
})

describe('versioned current state and result proposals', () => {
  it('preserves earlier snapshots, sources and existing facts while appending findings exactly once', () => {
    const original = createGoal({ title: 'Compare candidate options', currentSummary: 'Two candidates already exist' }, createdAt)
    const fact = createStateEntry('fact', 'Option A meets local deployment constraints', source, createdAt)
    const updated = updateGoalState(original, { appendEntries: [fact], reason: 'Complete deployment verification', source, eventKey: 'result-1', baseStateVersion: 1 })
    expect(original.currentState.entries).toEqual([])
    expect(updated.stateHistory[0].summary).toBe('Two candidates already exist')
    expect(updated.currentState.entries[0].source).toEqual(source)
    expect(updateGoalState(updated, { appendEntries: [fact], reason: 'Repeated delivery', eventKey: 'result-1' })).toBe(updated)
    fact.text = 'External object mutation'
    expect(updated.currentState.entries[0].text).toBe('Option A meets local deployment constraints')
    expect(() => updateGoalState(updated, { summary: '', reason: 'Stale form', baseStateVersion: 1 })).toThrow('现状已更新')
  })

  it('does not accept a stale proposal until the user reconciles it; accepted results never replace the state', () => {
    let goal = createGoal({ title: 'Compare candidate options', currentSummary: 'There are currently two candidates' }, createdAt)
    const entry = createStateEntry('hypothesis', 'Option B might be faster; measurement needed', source)
    goal = proposeGoalState(goal, { title: 'Research stage results', entries: [entry], source, eventKey: 'task-result-1' })
    const proposalId = goal.proposals[0].id
    expect(proposeGoalState(goal, { title: 'Repeated research result', entries: [entry], source, eventKey: 'task-result-1' })).toBe(goal)
    goal = updateGoalState(goal, { summary: 'A third candidate was added', reason: 'User addition' })
    expect(() => acceptGoalProposal(goal, proposalId)).toThrow('旧版现状')
    goal = rebaseGoalProposal(goal, proposalId)
    expect(goal.proposals[0].status).toBe('rejected')
    expect(goal.proposals[1].baseStateVersion).toBe(2)
    const accepted = acceptGoalProposal(goal, goal.proposals[1].id)
    expect(accepted.currentState.summary).toBe('A third candidate was added')
    expect(accepted.currentState.entries[0].kind).toBe('hypothesis')
    expect(accepted.currentState.entries).toHaveLength(1)
    expect(accepted.proposals[1].status).toBe('accepted')
    expect(acceptGoalProposal(accepted, accepted.proposals[1].id)).toBe(accepted)
  })

  it('allows a negative result to add knowledge without satisfying a goal condition', () => {
    let goal = createGoal({ title: 'Verify a technical plan', criteria: ['Choose a feasible option'] })
    goal = updateGoalState(goal, { reason: 'Experiment disproves the original hypothesis', appendEntries: [createStateEntry('fact', 'Experimental results show option A fails the constraints', source)] })
    expect(goal.criteria[0].status).toBe('unverified')
    expect(goal.currentState.entries[0].text).toContain('fails the constraints')
    expect(goal.status).not.toBe('achieved')
  })
})

describe('manual and in-app weekly reviews', () => {
  it('stores the actual goal and before/after state snapshots and requires evidence for a progress judgement', () => {
    let goal = createGoal({ title: 'Learn a skill', expected: 'Complete practice independently', currentSummary: 'Basics learned' }, createdAt)
    goal = updateGoalState(goal, { summary: 'Exercise completed with guidance still needed', reason: 'Practice results' })
    expect(() => saveGoalReview(goal, { summary: '符合计划', judgement: 'on_track', evidence: '', nextActions: [] })).toThrow('预期标准')
    const reviewed = saveGoalReview(goal, { summary: 'Evidence of independent completion is still missing', judgement: 'unknown', evidence: '', nextActions: ['Repeat the practice independently'] })
    expect(reviewed.reviews[0].beforeState.summary).toBe('Basics learned')
    expect(reviewed.reviews[0].afterState.summary).toBe('Exercise completed with guidance still needed')
    const changed = updateGoalState(reviewed, { summary: 'New current state', reason: 'Follow-up check' })
    expect(changed.reviews[0].afterState.summary).toBe('Exercise completed with guidance still needed')
    expect(changed.reviews[0].definition.expected).toBe('Complete practice independently')
  })

  it('uses configured time zone, catches up the latest missed week, and deduplicates persisted periods', () => {
    const base = createGoal({ title: 'Ongoing research', expected: 'Form an evidence-based conclusion' }, createdAt)
    const goal = { ...base, reviewSchedule: { enabled: true, weekday: 1, hour: 9, timeZone: 'Asia/Shanghai', startedAt: createdAt } }
    expect(dueReviewPeriod(goal, '2026-09-14T00:59:00.000Z')).toBeNull()
    expect(dueReviewPeriod(goal, '2026-09-14T01:00:00.000Z')).toEqual({ key: 'Asia/Shanghai:2026-09-14:09', scheduledFor: '2026-09-14T01:00:00.000Z' })
    const reviewed = createDueGoalReview(goal, '2026-09-24T04:00:00.000Z')
    expect(reviewed.reviews).toHaveLength(1)
    expect(reviewed.reviews[0]).toMatchObject({ trigger: 'weekly', judgement: 'unknown', needsAssessment: true, periodKey: 'Asia/Shanghai:2026-09-21:09', createdAt: '2026-09-24T04:00:00.000Z' })
    expect(createDueGoalReview(reviewed, '2026-09-24T05:00:00.000Z')).toBe(reviewed)
    expect(createDueGoalReview({ ...goal, status: 'paused' }, '2026-09-24T04:00:00.000Z').reviews).toEqual([])
  })

  it('does not backfill dates before schedule activation or fabricate positive progress', () => {
    const base = createGoal({ title: 'New goal' }, '2026-09-17T00:00:00.000Z')
    const goal = { ...base, reviewSchedule: { enabled: true, weekday: 1, hour: 9, timeZone: 'Asia/Shanghai', startedAt: '2026-09-17T00:00:00.000Z' } }
    expect(dueReviewPeriod(goal, '2026-09-17T02:00:00.000Z')).toBeNull()
    const reviewed = createDueGoalReview(goal, '2026-09-21T01:01:00.000Z')
    expect(reviewed.reviews[0].summary).toContain('0/0 项成功条件')
    expect(reviewed.reviews[0].judgement).toBe('unknown')
    expect(reviewed.reviews[0].nextActions).toEqual([])
    expect(dueReviewPeriod({ ...goal, reviewSchedule: { ...goal.reviewSchedule, timeZone: 'unknown' } }, '2026-09-21T01:01:00.000Z')).toBeNull()
  })

  it('resolves DST skipped/repeated hours and fractional UTC offsets without duplicate periods', () => {
    const base = createGoal({ title: 'Weekly research', expected: 'Preserve evidence of changes' }, '2026-01-01T00:00:00.000Z')
    const schedule = { enabled: true, weekday: 0, hour: 2, timeZone: 'America/New_York', startedAt: base.createdAt }
    const spring = { ...base, reviewSchedule: schedule }
    expect(dueReviewPeriod(spring, '2026-03-08T07:00:00.000Z')?.scheduledFor).toBe('2026-03-08T07:00:00.000Z')
    const fall = { ...base, reviewSchedule: { ...schedule, hour: 1 } }
    const first = createDueGoalReview(fall, '2026-11-01T05:00:00.000Z')
    expect(first.reviews[0].scheduledFor).toBe('2026-11-01T05:00:00.000Z')
    expect(createDueGoalReview(first, '2026-11-01T06:00:00.000Z')).toBe(first)
    const nepal = { ...base, reviewSchedule: { ...schedule, weekday: 1, hour: 9, timeZone: 'Asia/Kathmandu' } }
    expect(dueReviewPeriod(nepal, '2026-09-14T03:15:00.000Z')?.scheduledFor).toBe('2026-09-14T03:15:00.000Z')
  })
})
