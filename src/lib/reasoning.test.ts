import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { getModelReasoningOptions, getReasoningOptions, resolveReasoningEffort, validateModelReasoning, validateReasoning } from './reasoning'
import type { Member, ModelConfig, RuntimeConfig } from './types'

const runtimes = createInitialState().settings.runtimes
const codex = runtimes[0]
const model = (patch: Partial<ModelConfig> = {}): ModelConfig => ({ id: 'model', name: 'Astra', modelId: 'gpt-6-astra', runtimeIds: ['codex'], enabled: true, providerId: '', ...patch })
const member = (patch: Partial<Member> = {}): Member => ({ id: 'member', name: 'Codex', role: '执行', modelId: 'gpt-6-astra', runtimeId: 'codex', ...patch })

describe('reasoning configuration', () => {
  it('preserves old configurations and resolves member > model > runtime defaults', () => {
    expect(resolveReasoningEffort(member(), codex, [model()])).toBe('inherit')
    expect(resolveReasoningEffort(member(), codex, [model({ reasoningEffort: 'high' })])).toBe('high')
    expect(resolveReasoningEffort(member({ reasoningEffort: 'low' }), codex, [model({ reasoningEffort: 'high' })])).toBe('low')
    expect(resolveReasoningEffort(member({ reasoningEffort: 'inherit' }), codex, [model({ reasoningEffort: 'high' })])).toBe('inherit')
    expect(resolveReasoningEffort(member({ modelId: '' }), { ...codex, defaultModel: 'gpt-6-astra' }, [model({ reasoningEffort: 'max' })])).toBe('max')
  })
  it('uses discovered model capabilities ahead of the compatibility catalog', () => {
    expect(getReasoningOptions(codex, model()).map(option => option.value)).toContain('ultra')
    expect(getReasoningOptions(codex, model({ modelId: 'gpt-5.5' })).map(option => option.value)).not.toContain('max')
    expect(getReasoningOptions(codex, model({ supportedReasoningEfforts: ['low', 'high'] })).map(option => option.value)).toEqual(['inherit', 'low', 'high'])
    expect(getReasoningOptions(codex, model({ supportedReasoningEfforts: [] })).map(option => option.value)).toEqual(['inherit'])
  })
  it('limits shared model defaults to the intersection of compatible adapters', () => {
    const shared = model({ runtimeIds: ['codex', 'claude'] })
    expect(getModelReasoningOptions(shared, runtimes).map(option => option.value)).toEqual(['inherit', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(validateModelReasoning({ ...shared, reasoningEffort: 'ultra' }, runtimes)).toBeTruthy()
    expect(getModelReasoningOptions(model({ runtimeIds: ['codex', 'traex'] }), runtimes)).toEqual(getReasoningOptions(codex, model()))
    expect(getModelReasoningOptions(model({ runtimeIds: ['codex', 'deepseek-harness'] }), runtimes).map(option => option.value)).toEqual(['inherit'])
    expect(getReasoningOptions(runtimes[1], model({ modelId: 'claude-opus-4-6' })).map(option => option.value)).not.toContain('xhigh')
  })
  it('uses Kimi per-model efforts without guessing capabilities from a model name', () => {
    const kimi = runtimes.find(runtime => runtime.id === 'kimi')!
    const k3 = model({ modelId: 'kimi-code/k3', runtimeIds: ['kimi'], supportedReasoningEfforts: ['low', 'high', 'max'] })
    expect(getReasoningOptions(kimi, k3).map(option => option.value)).toEqual(['inherit', 'low', 'high', 'max'])
    expect(validateReasoning(kimi, k3, 'medium')).toContain('不支持')
    expect(validateReasoning(kimi, k3, 'max')).toBeUndefined()
    for (const metadata of [undefined, []]) {
      expect(getReasoningOptions(kimi, { ...k3, supportedReasoningEfforts: metadata }).map(option => option.value)).toEqual(['inherit'])
    }
    expect(getReasoningOptions(kimi).map(option => option.value)).toEqual(['inherit'])
    const kimiMember = member({ runtimeId: 'kimi', modelId: k3.modelId, reasoningEffort: 'low' })
    expect(resolveReasoningEffort(kimiMember, kimi, [{ ...k3, reasoningEffort: 'max' }])).toBe('low')
    expect(resolveReasoningEffort({ ...kimiMember, reasoningEffort: undefined }, kimi, [{ ...k3, reasoningEffort: 'max' }])).toBe('max')
    expect(getModelReasoningOptions({ ...k3, runtimeIds: ['kimi', 'claude'] }, runtimes).map(option => option.value)).toEqual(['inherit'])
    expect(getModelReasoningOptions({ ...k3, runtimeIds: ['kimi', 'claude'], supportedReasoningEffortsByRuntime: { kimi: ['low', 'high', 'max'] } }, runtimes).map(option => option.value)).toEqual(['inherit', 'low', 'high', 'max'])
  })
  it('uses each runtime capability list when a model alias is shared by Codex and Kimi', () => {
    const kimi = runtimes.find(runtime => runtime.id === 'kimi')!
    const shared = model({
      modelId: 'gpt-5.5', runtimeIds: ['codex', 'kimi'], supportedReasoningEfforts: ['ultra'],
      supportedReasoningEffortsByRuntime: { codex: ['low', 'medium', 'high', 'xhigh'], kimi: ['low', 'high', 'max'] },
    })
    expect(getReasoningOptions(codex, shared).map(option => option.value)).toEqual(['inherit', 'low', 'medium', 'high', 'xhigh'])
    expect(getReasoningOptions(kimi, shared).map(option => option.value)).toEqual(['inherit', 'low', 'high', 'max'])
    expect(getModelReasoningOptions(shared, runtimes).map(option => option.value)).toEqual(['inherit', 'low', 'high'])
    expect(validateModelReasoning({ ...shared, reasoningEffort: 'max' }, runtimes)).toContain('全部兼容 Runtime')
    expect(getReasoningOptions(kimi, { ...shared, supportedReasoningEffortsByRuntime: { kimi: [] } }).map(option => option.value)).toEqual(['inherit'])
  })
  it('rejects malformed runtime-scoped capability maps without treating them as selectable values', () => {
    for (const metadata of [null, [], 'high', { kimi: 'high' }, { kimi: ['inherit'] }, { kimi: ['future-effort'] }, { '': ['high'] }]) {
      const invalid = model({ supportedReasoningEffortsByRuntime: metadata as never })
      expect(validateModelReasoning(invalid, runtimes)).toContain('能力数据无效')
    }
    const malformed = model({ supportedReasoningEfforts: ['high'], supportedReasoningEffortsByRuntime: { codex: 'high' } as never })
    expect(getReasoningOptions(codex, malformed).map(option => option.value)).toEqual(['inherit'])
  })
  it('rejects malformed, unsupported and generic explicit values before execution', () => {
    expect(validateReasoning(codex, model(), null)).toBeTruthy()
    expect(validateReasoning(codex, model(), 'persistent')).toBeTruthy()
    expect(validateReasoning(codex, model({ modelId: 'gpt-5.5' }), 'ultra')).toBeTruthy()
    expect(validateReasoning(runtimes.find(runtime => runtime.id === 'deepseek-harness')!, model(), 'high')).toContain('通用适配器')
    expect(validateReasoning(runtimes[2], model(), 'inherit')).toBeUndefined()
    expect(() => resolveReasoningEffort(member(), codex, [model({ reasoningEffort: null as never })])).toThrow('无效')
  })
  it.each([
    ['-c', 'model_reasoning_effort=low'], ['--config=model_reasoning_effort=low'], ['-c=model_reasoning_effort=low'],
    ['-cmodel=other'], ['--profile=team'], ['-pteam'], ['-mother'], ['--'], ['-c', '"profiles".team.model_reasoning_effort=low'],
  ])('rejects explicit Codex conflicts: %j', (...args) => {
    expect(validateReasoning({ ...codex, args }, model(), 'high')).toContain('冲突')
    expect(validateReasoning({ ...codex, args }, model(), 'inherit')).toBeUndefined()
  })
  it('allows unrelated config and catches Claude effort/model/settings conflicts', () => {
    expect(validateReasoning({ ...codex, args: ['-c', 'model_reasoning_summary=concise'] }, model(), 'high')).toBeUndefined()
    for (const arg of ['--effort=low', '--settings={}', '--model=other', '--fallback-model=other', '-mother', '--']) {
      expect(validateReasoning({ ...runtimes[1], args: [arg] } as RuntimeConfig, model(), 'high')).toContain('冲突')
    }
  })
})
