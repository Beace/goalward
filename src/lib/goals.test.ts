import { describe, expect, it } from 'vitest'
import { acceptGoalProposal, createDueGoalReview, createGoal, createStateEntry, dueReviewPeriod, proposeGoalState, rebaseGoalProposal, reviseGoal, saveGoalReview, setGoalStatus, updateCriterion, updateGoalState } from './goals'

const createdAt = '2026-09-14T00:00:00.000Z'
const source = { kind: 'task' as const, label: '用户验收的研究结果', taskId: 'task-1', runId: 'run-1', reference: '/tmp/research.md' }

describe('goal definitions and success conditions', () => {
  it('creates an unseeded goal from only a user description, without Runtime or metric prerequisites', () => {
    const goal = createGoal({ title: '  研究一个可行方案  ' }, createdAt)
    expect(goal.title).toBe('研究一个可行方案')
    expect(goal.status).toBe('clarifying')
    expect(goal.criteria).toEqual([])
    expect(goal.currentState.entries).toEqual([])
    expect(goal.currentState.summary).toBe('')
    expect(goal.reviews).toEqual([])
    expect(goal.definitions[0].title).toBe(goal.title)
    expect(() => createGoal({ title: ' ' })).toThrow('请先描述')
  })

  it('requires explicit success evidence and invalidates achievement after a changed criterion', () => {
    let goal = createGoal({ title: '交付桌面工具', expected: '可以试用', criteria: ['安装包通过试用'] }, createdAt)
    expect(() => setGoalStatus(goal, 'achieved')).toThrow('逐项确认')
    expect(() => updateCriterion(goal, goal.criteria[0].id, 'satisfied', '')).toThrow('验收依据')
    goal = updateCriterion(goal, goal.criteria[0].id, 'satisfied', '用户已完成安装与主要流程检查')
    const achieved = setGoalStatus(goal, 'achieved')
    expect(achieved.status).toBe('achieved')
    const revised = reviseGoal(achieved, { title: achieved.title, intent: '', expected: '团队可试用', constraints: '离线使用', deadline: '', criteria: ['安装包通过试用', '离线流程可用'], reason: '增加离线要求' })
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('active')
    expect(revised.criteria.map(criterion => criterion.status)).toEqual(['satisfied', 'unverified'])
    expect(revised.definitions[0].expected).toBe('可以试用')
    expect(achieved.criteria).toHaveLength(1)
  })
})

describe('versioned current state and result proposals', () => {
  it('preserves earlier snapshots, sources and existing facts while appending findings exactly once', () => {
    const original = createGoal({ title: '比较候选方案', currentSummary: '已有两个候选' }, createdAt)
    const fact = createStateEntry('fact', '方案 A 满足本地部署约束', source, createdAt)
    const updated = updateGoalState(original, { appendEntries: [fact], reason: '完成部署验证', source, eventKey: 'result-1', baseStateVersion: 1 })
    expect(original.currentState.entries).toEqual([])
    expect(updated.stateHistory[0].summary).toBe('已有两个候选')
    expect(updated.currentState.entries[0].source).toEqual(source)
    expect(updateGoalState(updated, { appendEntries: [fact], reason: '重复送达', eventKey: 'result-1' })).toBe(updated)
    fact.text = '外部对象修改'
    expect(updated.currentState.entries[0].text).toBe('方案 A 满足本地部署约束')
    expect(() => updateGoalState(updated, { summary: '', reason: '过期表单', baseStateVersion: 1 })).toThrow('现状已更新')
  })

  it('does not accept a stale proposal until the user reconciles it; accepted results never replace the state', () => {
    let goal = createGoal({ title: '比较候选方案', currentSummary: '当前有两个候选' }, createdAt)
    const entry = createStateEntry('hypothesis', '方案 B 可能更快，仍需测量', source)
    goal = proposeGoalState(goal, { title: '研究阶段结果', entries: [entry], source, eventKey: 'task-result-1' })
    const proposalId = goal.proposals[0].id
    expect(proposeGoalState(goal, { title: '重复研究结果', entries: [entry], source, eventKey: 'task-result-1' })).toBe(goal)
    goal = updateGoalState(goal, { summary: '新增了第三个候选', reason: '用户补充' })
    expect(() => acceptGoalProposal(goal, proposalId)).toThrow('旧版现状')
    goal = rebaseGoalProposal(goal, proposalId)
    expect(goal.proposals[0].status).toBe('rejected')
    expect(goal.proposals[1].baseStateVersion).toBe(2)
    const accepted = acceptGoalProposal(goal, goal.proposals[1].id)
    expect(accepted.currentState.summary).toBe('新增了第三个候选')
    expect(accepted.currentState.entries[0].kind).toBe('hypothesis')
    expect(accepted.currentState.entries).toHaveLength(1)
    expect(accepted.proposals[1].status).toBe('accepted')
    expect(acceptGoalProposal(accepted, accepted.proposals[1].id)).toBe(accepted)
  })

  it('allows a negative result to add knowledge without satisfying a goal condition', () => {
    let goal = createGoal({ title: '验证技术方案', criteria: ['选出可行方案'] })
    goal = updateGoalState(goal, { reason: '实验否定原假设', appendEntries: [createStateEntry('fact', '实验结果显示方案 A 不满足约束', source)] })
    expect(goal.criteria[0].status).toBe('unverified')
    expect(goal.currentState.entries[0].text).toContain('不满足')
    expect(goal.status).not.toBe('achieved')
  })
})

describe('manual and in-app weekly reviews', () => {
  it('stores the actual goal and before/after state snapshots and requires evidence for a progress judgement', () => {
    let goal = createGoal({ title: '学习一项技能', expected: '独立完成实践', currentSummary: '已学习基础' }, createdAt)
    goal = updateGoalState(goal, { summary: '完成练习，但仍需指导', reason: '练习结果' })
    expect(() => saveGoalReview(goal, { summary: '符合计划', judgement: 'on_track', evidence: '', nextActions: [] })).toThrow('预期标准')
    const reviewed = saveGoalReview(goal, { summary: '仍缺少独立完成的证据', judgement: 'unknown', evidence: '', nextActions: ['再做一次独立实践'] })
    expect(reviewed.reviews[0].beforeState.summary).toBe('已学习基础')
    expect(reviewed.reviews[0].afterState.summary).toBe('完成练习，但仍需指导')
    const changed = updateGoalState(reviewed, { summary: '新现状', reason: '后续检查' })
    expect(changed.reviews[0].afterState.summary).toBe('完成练习，但仍需指导')
    expect(changed.reviews[0].definition.expected).toBe('独立完成实践')
  })

  it('uses configured time zone, catches up the latest missed week, and deduplicates persisted periods', () => {
    const base = createGoal({ title: '持续研究', expected: '形成有依据的结论' }, createdAt)
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
    const base = createGoal({ title: '新目标' }, '2026-09-17T00:00:00.000Z')
    const goal = { ...base, reviewSchedule: { enabled: true, weekday: 1, hour: 9, timeZone: 'Asia/Shanghai', startedAt: '2026-09-17T00:00:00.000Z' } }
    expect(dueReviewPeriod(goal, '2026-09-17T02:00:00.000Z')).toBeNull()
    const reviewed = createDueGoalReview(goal, '2026-09-21T01:01:00.000Z')
    expect(reviewed.reviews[0].summary).toContain('0/0 项成功条件')
    expect(reviewed.reviews[0].judgement).toBe('unknown')
    expect(reviewed.reviews[0].nextActions).toEqual([])
    expect(dueReviewPeriod({ ...goal, reviewSchedule: { ...goal.reviewSchedule, timeZone: 'unknown' } }, '2026-09-21T01:01:00.000Z')).toBeNull()
  })

  it('resolves DST skipped/repeated hours and fractional UTC offsets without duplicate periods', () => {
    const base = createGoal({ title: '每周研究', expected: '保留变化依据' }, '2026-01-01T00:00:00.000Z')
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
