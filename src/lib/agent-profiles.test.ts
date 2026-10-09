import { describe, expect, it } from 'vitest'
import { agentActivity, agentFromMember, createAgentProfile, duplicateAgentProfile, memberFromAgent, normalizeAgentProfiles, updateAgentProfile, updateMemberFromAgent } from './agent-profiles'
import type { Run, Settings, Task } from './types'

const settings: Settings = {
  runtimes: [
    { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: '' },
    { id: 'claude', name: 'Claude Code', executable: 'claude', adapter: 'claude', enabled: true, args: [], defaultModel: '', description: '' },
  ], models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', defaultDirectory: '', maxParallel: 3, outputLimit: 65536,
}

describe('reusable agent profiles', () => {
  it('versions saved configuration without touching task members or historic run snapshots', () => {
    const profile = createAgentProfile(settings, { name: '实现', instructions: '验证改动' })
    const member = memberFromAgent(profile)
    const run: Run = { id: 'r', createdAt: '2026-09-17T01:00:00Z', prompt: 'task', directory: '', members: [{ ...member, runtime: structuredClone(settings.runtimes[0]), model: '', status: 'completed' }] }
    const before = structuredClone(run)
    const updated = updateAgentProfile(profile, { name: '实现工程师', instructions: '运行相关测试' }, settings)
    expect(updated.version).toBe(2)
    expect(updated.history.map(item => item.snapshot.instructions)).toEqual(['验证改动', '运行相关测试'])
    expect(member.name).toBe('实现')
    expect(run).toEqual(before)
    expect(updateAgentProfile(updated, { name: updated.name }, settings)).toBe(updated)
  })

  it('explicit refresh updates inherited fields while preserving task instructions and compatible execution override group', () => {
    const profile = createAgentProfile(settings, { name: '研究', role: '研究', instructions: '输出依据' })
    const member = { ...memberFromAgent(profile), instructions: '只使用官方资料', modelId: 'custom-model' }
    const newer = updateAgentProfile(profile, { name: '研究助手', runtimeId: 'claude', modelId: 'opus', instructions: '全面调研' }, settings)
    const result = updateMemberFromAgent(member, newer)
    expect(result.member).toMatchObject({ name: '研究助手', instructions: '只使用官方资料', runtimeId: 'codex', modelId: 'custom-model', agentProfileVersion: 2 })
    expect(result.preservedFields).toEqual(['instructions', 'runtimeId', 'modelId', 'reasoningEffort'])
    expect(member.agentProfileVersion).toBe(1)
  })

  it('refresh rejects missing baselines rather than silently overwriting local overrides', () => {
    const profile = createAgentProfile(settings, { name: 'Agent' })
    expect(() => updateMemberFromAgent({ ...memberFromAgent(profile), agentProfileVersion: 999 }, profile)).toThrow('找不到成员引用的档案版本')
    expect(() => updateMemberFromAgent({ ...memberFromAgent(profile), agentProfileId: 'other' }, profile)).toThrow('未关联')
  })

  it('disabling blocks new assignment but does not prevent safe updates of existing members', () => {
    const profile = createAgentProfile(settings, { name: 'Agent' }), member = memberFromAgent(profile)
    const disabled = { ...updateAgentProfile(profile, { name: 'Renamed' }, settings), enabled: false }
    expect(() => memberFromAgent(disabled)).toThrow('停用')
    expect(updateMemberFromAgent(member, disabled).member.name).toBe('Renamed')
  })

  it('duplicates independently without carrying assignments or revision identity', () => {
    const original = createAgentProfile(settings, { name: 'Agent', assignedGoalIds: ['g'], instructions: 'do work' })
    const copy = duplicateAgentProfile(original)
    expect(copy.id).not.toBe(original.id)
    expect(copy.assignedGoalIds).toEqual([])
    expect(copy.history).toHaveLength(1)
    expect(copy.instructions).toBe(original.instructions)
    const savedMember = agentFromMember(memberFromAgent(original), settings, '从任务保存')
    expect(savedMember.id).not.toBe(original.id)
    expect(savedMember.name).toBe('从任务保存')
  })

  it('counts concrete member executions, excludes demo data and retains historical association', () => {
    const profile = createAgentProfile(settings, { name: 'Agent' }), member = memberFromAgent(profile)
    const run: Run = { id: 'r', createdAt: '2026-09-17T01:00:00Z', prompt: 'task', directory: '', members: [1, 2].map(index => ({ ...member, id: `m${index}`, runtime: settings.runtimes[0], model: '', status: index === 1 ? 'running' : 'failed' })) }
    const task: Task = { id: 't', title: 'Real', directory: '', mode: 'team', members: [], messages: [], runs: [run], events: [], createdAt: run.createdAt }
    const activity = agentActivity(profile.id, [task, { ...task, id: 'demo', demo: true }])
    expect(activity.tasks.map(item => item.id)).toEqual(['t'])
    expect(activity.executions).toHaveLength(2)
    expect(activity.active).toHaveLength(1)
  })

  it('normalizes persisted profiles without inventing profiles for legacy tasks', () => {
    expect(normalizeAgentProfiles(undefined, settings)).toEqual([])
    const profile = createAgentProfile(settings, { name: 'Agent', assignedGoalIds: ['g', 'g'] })
    const profiles = normalizeAgentProfiles([profile, profile, null, { name: 'missing id' }], settings)
    expect(profiles).toEqual([profile])
    expect(normalizeAgentProfiles([{ ...profile, version: 2, history: [] }], settings)[0].history[0].version).toBe(2)
  })
})
