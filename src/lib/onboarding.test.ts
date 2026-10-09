import { describe, expect, it } from 'vitest'
import { createInitialState, createTask } from './domain'
import { canConfigureTask, hasStarterSettings, mergeLocalDiscovery } from './onboarding'
import { getModelReasoningOptions, getReasoningOptions } from './reasoning'
import type { DiscoveredRuntime, LocalDiscoveryReport } from './types'

const found = (id = 'codex', patch: Partial<DiscoveredRuntime> = {}): DiscoveredRuntime => ({
  id, name: id, executable: id, adapter: id === 'codex' || id === 'traex' ? 'codex' : id === 'claude' ? 'claude' : 'generic',
  probe: { found: true, path: `/local/bin/${id}`, version: '1.2.3' },
  models: [{ modelId: 'local-model', name: 'Local model', source: 'local config', selected: true }],
  configSources: ['local config'], warnings: [], ...patch,
})
const report = (...runtimes: DiscoveredRuntime[]): LocalDiscoveryReport => ({ scannedAt: '2026-09-15T12:00:00Z', runtimes })

describe('local environment import', () => {
  it('refreshes Kimi capabilities on existing aliases while preserving user settings and explicit defaults', () => {
    const settings = createInitialState().settings
    const kimi = settings.runtimes.find(runtime => runtime.id === 'kimi')!
    kimi.enabled = true
    settings.models = [{ id: 'existing-k3', modelId: 'kimi-code/k3', name: 'My K3', runtimeIds: ['kimi'], providerId: '', enabled: false, reasoningEffort: 'high' }]
    const discovered = found('kimi', { adapter: 'kimi', models: [{ modelId: 'kimi-code/k3', name: 'K3', source: 'Kimi config', selected: true, supportedReasoningEfforts: ['low', 'high', 'max'] }] })
    const next = mergeLocalDiscovery(settings, report(discovered), ['kimi'], '')
    expect(next.models).toEqual([{ ...settings.models[0], supportedReasoningEffortsByRuntime: { kimi: ['low', 'high', 'max'] } }])
    expect(next.runtimes).toEqual(settings.runtimes)
    const refreshed = mergeLocalDiscovery(next, report({ ...discovered, models: [{ ...discovered.models[0], supportedReasoningEfforts: [] }] }), ['kimi'], '')
    expect(refreshed.models).toEqual([{ ...settings.models[0], supportedReasoningEffortsByRuntime: { kimi: [] } }])
    expect(settings.models[0].supportedReasoningEfforts).toBeUndefined()
    expect(settings.models[0].supportedReasoningEffortsByRuntime).toBeUndefined()
  })
  it.each([['codex', 'kimi'], ['kimi', 'codex']])('keeps shared aliases scoped when imported in %s then %s order', (first, second) => {
    const codexEfforts = ['low', 'medium', 'high', 'xhigh'] as const
    const kimiEfforts = ['low', 'high', 'max'] as const
    const catalogs = {
      codex: found('codex', { models: [{ modelId: 'gpt-5.5', name: 'GPT-5.5', source: 'Codex cache', selected: true, supportedReasoningEfforts: [...codexEfforts] }] }),
      kimi: found('kimi', { adapter: 'kimi', models: [{ modelId: 'gpt-5.5', name: 'Kimi alias', source: 'Kimi config', selected: true, supportedReasoningEfforts: [...kimiEfforts] }] }),
    }
    const initial = mergeLocalDiscovery(createInitialState().settings, report(catalogs[first as keyof typeof catalogs]), [first], '')
    initial.models[0].name = 'My shared model'
    initial.models[0].reasoningEffort = 'high'
    const next = mergeLocalDiscovery(initial, report(catalogs[second as keyof typeof catalogs]), [second], '')
    const codex = next.runtimes.find(runtime => runtime.id === 'codex')!
    const kimi = next.runtimes.find(runtime => runtime.id === 'kimi')!
    expect(next.models).toHaveLength(1)
    expect(next.models[0]).toMatchObject({ name: 'My shared model', reasoningEffort: 'high', supportedReasoningEfforts: [...codexEfforts], supportedReasoningEffortsByRuntime: { codex: [...codexEfforts], kimi: [...kimiEfforts] } })
    expect(getReasoningOptions(codex, next.models[0]).map(option => option.value)).toEqual(['inherit', ...codexEfforts])
    expect(getReasoningOptions(kimi, next.models[0]).map(option => option.value)).toEqual(['inherit', ...kimiEfforts])
    expect(getModelReasoningOptions(next.models[0], next.runtimes).map(option => option.value)).toEqual(['inherit', 'low', 'high'])
    const cleared = mergeLocalDiscovery(next, report({ ...catalogs.kimi, models: [{ ...catalogs.kimi.models[0], supportedReasoningEfforts: [] }] }), ['kimi'], '')
    expect(cleared.models[0].supportedReasoningEffortsByRuntime).toEqual({ codex: [...codexEfforts], kimi: [] })
    expect(getReasoningOptions(codex, cleared.models[0]).map(option => option.value)).toEqual(['inherit', ...codexEfforts])
    expect(getReasoningOptions(kimi, cleared.models[0]).map(option => option.value)).toEqual(['inherit'])
  })
  it('recognizes only untouched starter state and preserves existing task installs', () => {
    const state = createInitialState()
    expect(hasStarterSettings(state)).toBe(true)
    state.settings.defaultDirectory = '/work'
    expect(hasStarterSettings(state)).toBe(false)
    const existing = createInitialState()
    existing.tasks.push(createTask(existing.settings, 'real', '/work', 'solo'))
    expect(hasStarterSettings(existing)).toBe(false)
  })
  it('imports selected installed runtimes, model ids and selected defaults; missing ones are disabled for first run', () => {
    const settings = createInitialState().settings
    const next = mergeLocalDiscovery(settings, report(found(), found('claude', { probe: { found: false, path: '', version: '' } })), ['codex', 'claude'], 'codex', true)
    expect(next.runtimes.filter(canConfigureTask).map(runtime => runtime.id)).toEqual(['codex'])
    expect(next.runtimes[0]).toMatchObject({ executable: '/local/bin/codex', defaultModel: 'local-model' })
    expect(next.models).toHaveLength(1)
    expect(next.models[0].runtimeIds).toEqual(['codex'])
    expect(settings.runtimes[0].executable).toBe('codex')
  })
  it('keeps the runtime default empty when the scanner has only cached choices', () => {
    const next = mergeLocalDiscovery(createInitialState().settings, report(found('codex', { models: [{ modelId: 'cache-model', name: '', source: 'cache', selected: false }] })), ['codex'], 'codex', true)
    expect(next.runtimes[0].defaultModel).toBe('')
    expect(next.models[0].modelId).toBe('cache-model')
  })
  it('does not enable generic runtimes with no prompt template or failed version probes', () => {
    const next = mergeLocalDiscovery(createInitialState().settings, report(found('deepseek-harness'), found('codex', { probe: { found: true, path: '/local/bin/codex', version: '', error: 'timeout' } })), ['deepseek-harness', 'codex'], 'codex', true)
    expect(next.runtimes.some(canConfigureTask)).toBe(false)
    expect(next.defaultRuntime).toBe('')
    expect(() => createTask(next, 'task', '/tmp', 'solo')).toThrow()
  })
  it('imports TraeX ready to execute through Codex without prompt configuration', () => {
    const discovered = found('traex', {
      models: [
        { modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', source: 'traecli.toml / model', selected: true },
        { modelId: 'catalog-model', name: 'Catalog model', source: 'traex models --json', selected: false },
      ],
      configSources: ['/home/.trae/traecli.toml'],
    })
    const next = mergeLocalDiscovery(createInitialState().settings, report(discovered), ['traex'], 'traex', true)
    const runtime = next.runtimes.find(item => item.id === 'traex')!
    expect(runtime).toMatchObject({ executable: '/local/bin/traex', adapter: 'codex', defaultModel: 'GPT-6-Astra', enabled: true, args: [] })
    expect(next.models.map(({ modelId, name, runtimeIds, providerId, enabled }) => ({ modelId, name, runtimeIds, providerId, enabled }))).toEqual([
      { modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', runtimeIds: ['traex'], providerId: '', enabled: true },
      { modelId: 'catalog-model', name: 'Catalog model', runtimeIds: ['traex'], providerId: '', enabled: true },
    ])
    expect(next.providers).toEqual([])
    expect(canConfigureTask(runtime)).toBe(true)
    expect(next.defaultRuntime).toBe('traex')
  })
  it('keeps TraeX model identities stable and adds only new choices on repeated discovery imports', () => {
    const initial = found('traex', { models: [{ modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', source: 'traecli.toml / model', selected: true }] })
    const first = mergeLocalDiscovery(createInitialState().settings, report(initial), ['traex'], '', true)
    const nextReport = report(found('traex', { models: [
      { modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', source: 'traex models --json', selected: true },
      { modelId: 'catalog-model', name: 'Catalog model', source: 'traex models --json', selected: false },
    ] }))
    const second = mergeLocalDiscovery(first, nextReport, ['traex'], '', false, first.runtimes)
    const third = mergeLocalDiscovery(second, nextReport, ['traex'], '', false, second.runtimes)
    expect(second.models).toHaveLength(2)
    expect(second.models[0]).toEqual(first.models[0])
    expect(third.models).toEqual(second.models)
    expect(third.runtimes.find(runtime => runtime.id === 'traex')).toMatchObject({ enabled: true, defaultModel: 'GPT-6-Astra' })
  })
  it('preserves a previously imported TraeX alias when the CLI catalog recovers and its configured default changes', () => {
    const first = mergeLocalDiscovery(createInitialState().settings, report(found('traex', {
      models: [{ modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', source: 'traecli.toml / model', selected: true }],
    })), ['traex'], '', true)
    first.models[0].name = 'My daily model'
    const catalog = (astraSelected: boolean) => report(found('traex', { models: [
      { modelId: 'gpt-6-astra', name: 'GPT-6-Astra', aliases: ['GPT-6-Astra'], source: 'traex models --json', selected: astraSelected },
      { modelId: 'other-model', name: 'Other model', source: 'traex models --json', selected: !astraSelected },
    ] }))
    const second = mergeLocalDiscovery(first, catalog(true), ['traex'], '', false, first.runtimes)
    expect(second.models).toHaveLength(2)
    expect(second.models[0]).toEqual(first.models[0])
    expect(second.runtimes.find(runtime => runtime.id === 'traex')!.defaultModel).toBe('GPT-6-Astra')
    const third = mergeLocalDiscovery(second, catalog(false), ['traex'], '', false, second.runtimes)
    expect(third.models).toEqual(second.models)
    expect(third.runtimes.find(runtime => runtime.id === 'traex')!.defaultModel).toBe('other-model')
    const fourth = mergeLocalDiscovery(third, catalog(true), ['traex'], '', false, third.runtimes)
    expect(fourth.models).toEqual(second.models)
    expect(fourth.runtimes.find(runtime => runtime.id === 'traex')!.defaultModel).toBe('GPT-6-Astra')
  })
  it('preserves disabled TraeX model aliases without adopting them as the runtime default', () => {
    const settings = createInitialState().settings
    settings.models = [{ id: 'legacy', modelId: 'GPT-6-Astra', name: 'My disabled model', providerId: '', runtimeIds: ['traex'], enabled: false }]
    const next = mergeLocalDiscovery(settings, report(found('traex', {
      models: [{ modelId: 'gpt-6-astra', name: 'GPT-6-Astra', aliases: ['GPT-6-Astra'], source: 'traex models --json', selected: true }],
    })), ['traex'], '', false)
    expect(next.models).toEqual(settings.models)
    expect(next.runtimes.find(runtime => runtime.id === 'traex')!.defaultModel).toBe('')
  })
  it('does not infer model aliases from display names, letter case or another runtime', () => {
    const settings = createInitialState().settings
    settings.models = [
      { id: 'other-runtime', modelId: 'GPT-6-Astra', name: 'GPT-6-Astra', providerId: '', runtimeIds: ['claude'], enabled: true },
      { id: 'different-case', modelId: 'gpt-6-astra', name: 'GPT-6-Astra', providerId: '', runtimeIds: ['traex'], enabled: true },
      { id: 'same-name', modelId: 'unrelated-model', name: 'GPT-6-Astra', providerId: '', runtimeIds: ['traex'], enabled: true },
    ]
    const next = mergeLocalDiscovery(settings, report(found('traex', {
      models: [{ modelId: 'gpt-6-astra-canonical', name: 'GPT-6-Astra', aliases: ['GPT-6-Astra'], source: 'traex models --json', selected: true }],
    })), ['traex'], '', false)
    expect(next.models).toHaveLength(4)
    expect(next.models.slice(0, 3)).toEqual(settings.models)
    expect(next.models[3]).toMatchObject({ modelId: 'gpt-6-astra-canonical', runtimeIds: ['traex'], enabled: true })
    expect(next.runtimes.find(runtime => runtime.id === 'traex')!.defaultModel).toBe('gpt-6-astra-canonical')
  })
  it.each([true, false])('preserves edited TraeX arguments, model and permissions with enabled=%s when importing new models', enabled => {
    const imported = mergeLocalDiscovery(createInitialState().settings, report(found('traex')), ['traex'], '', true)
    const managed = structuredClone(imported.runtimes)
    const runtime = imported.runtimes.find(item => item.id === 'traex')!
    runtime.enabled = enabled
    runtime.args = ['--profile', 'team']
    runtime.defaultModel = 'manual-model'
    runtime.permissions = { codex: { sandbox: 'inherit', network: 'inherit', additionalDirectories: [] } }
    const scanned = mergeLocalDiscovery(imported, report(found('traex', {
      models: [{ modelId: 'new-model', name: 'New model', source: 'traex models --json', selected: true }],
    })), ['traex'], '', false, managed)
    expect(scanned.runtimes.find(item => item.id === 'traex')).toEqual(runtime)
    expect(scanned.models.map(model => model.modelId)).toEqual(['local-model', 'new-model'])
    expect(scanned.models.every(model => model.runtimeIds.includes('traex'))).toBe(true)
    expect(scanned.runtimes.find(item => item.id === 'traex')!.permissions).not.toBe(runtime.permissions)
  })
  it('preserves custom paths, arguments, disabled state, model and provider configuration', () => {
    const settings = createInitialState().settings
    settings.runtimes[0] = { ...settings.runtimes[0], executable: '/custom/codex', args: ['--profile', 'team'], enabled: false, defaultModel: 'my-model' }
    settings.providers = [{ id: 'provider', name: 'Existing', baseUrl: 'https://example.org', credentialEnv: 'MY_KEY' }]
    const next = mergeLocalDiscovery(settings, report(found()), ['codex'], '', false)
    expect(next.runtimes[0]).toEqual(settings.runtimes[0])
    expect(next.providers).toEqual(settings.providers)
    expect(next.models).toEqual([])
  })
  it('merges model associations without duplicates or re-enabling disabled user choices', () => {
    const settings = createInitialState().settings
    settings.models = [{ id: 'existing', modelId: 'local-model', name: 'User label', providerId: '', runtimeIds: ['claude'], enabled: false }]
    const first = mergeLocalDiscovery(settings, report(found(), found('claude')), ['codex', 'claude'], '', false)
    const next = mergeLocalDiscovery(first, report(found(), found('claude')), ['codex', 'claude'], '', false)
    expect(next.models).toEqual([{ ...settings.models[0], runtimeIds: ['claude', 'codex'] }])
    expect(next.runtimes[0].defaultModel).toBe('')
  })
  it('preserves manually configured TraeX options when importing models from the same installation', () => {
    const settings = createInitialState().settings
    settings.runtimes[2] = { ...settings.runtimes[2], enabled: true, args: ['--profile', 'team'], defaultModel: 'custom-default' }
    settings.defaultRuntime = 'traex'
    const next = mergeLocalDiscovery(settings, report(found('traex')), ['traex'], '', false)
    expect(next.runtimes[2]).toEqual(settings.runtimes[2])
    expect(next.defaultRuntime).toBe('traex')
    expect(next.models[0].runtimeIds).toEqual(['traex'])
  })
  it('leaves unrelated runtime configurations intact when a rescan finds nothing', () => {
    const settings = createInitialState().settings
    const next = mergeLocalDiscovery(settings, report(), [], '', false)
    expect(next).toEqual(settings)
    const fresh = mergeLocalDiscovery(settings, report(), [], '', true)
    expect(fresh.runtimes.some(runtime => runtime.enabled)).toBe(false)
    expect(fresh.defaultRuntime).toBe('')
  })
  it('enables a previously missing auto-managed runtime after install, but preserves a later manual edit', () => {
    const missing = mergeLocalDiscovery(createInitialState().settings, report(), [], '', true)
    const managed = structuredClone(missing.runtimes)
    const installed = mergeLocalDiscovery(missing, report(found()), ['codex'], 'codex', false, managed)
    expect(installed.runtimes[0]).toMatchObject({ enabled: true, executable: '/local/bin/codex' })
    missing.runtimes[0].executable = '/user/chosen/codex'
    const customized = mergeLocalDiscovery(missing, report(found()), ['codex'], 'codex', false, managed)
    expect(customized.runtimes[0]).toEqual(missing.runtimes[0])
  })
  it('recognizes saved settings even when the Rust JSON serializer reorders keys', () => {
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, reorder(item)])) : value
    const state = reorder(createInitialState()) as ReturnType<typeof createInitialState>
    expect(hasStarterSettings(state)).toBe(true)
    const next = mergeLocalDiscovery(state.settings, report(found()), ['codex'], 'codex', true)
    expect(next.runtimes[0]).toMatchObject({ executable: '/local/bin/codex', defaultModel: 'local-model', enabled: true })
    const missing = mergeLocalDiscovery(state.settings, report(), [], '', true)
    const saved = reorder(missing) as typeof missing
    const restored = mergeLocalDiscovery(saved, report(found()), ['codex'], 'codex', false, missing.runtimes)
    expect(restored.runtimes[0].enabled).toBe(true)
  })
  it('preserves user permissions when rediscovering an automatically imported runtime', () => {
    const imported = mergeLocalDiscovery(createInitialState().settings, report(found()), ['codex'], 'codex', true)
    const managed = structuredClone(imported.runtimes)
    imported.runtimes[0].permissions = { codex: { sandbox: 'read-only', network: 'inherit', additionalDirectories: [] } }
    const reloaded = JSON.parse(JSON.stringify(imported)) as typeof imported
    const scanned = mergeLocalDiscovery(reloaded, report(found()), ['codex'], 'codex', false, managed)
    expect(scanned.runtimes[0]).toEqual(imported.runtimes[0])
    expect(scanned.runtimes[0].permissions).not.toBe(imported.runtimes[0].permissions)
  })
})


it('refreshes discovered reasoning capabilities without replacing a manually selected default', () => {
  const scanned = found('codex', { models: [{ modelId: 'local-model', name: 'Model', source: 'cache', selected: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }] })
  const initial = mergeLocalDiscovery(createInitialState().settings, report(scanned), ['codex'], 'codex', true)
  expect(initial.models[0].supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
  initial.models[0].reasoningEffort = 'high'
  scanned.models[0].supportedReasoningEfforts = ['low', 'medium', 'high', 'max']
  const refreshed = mergeLocalDiscovery(initial, report(scanned), ['codex'], '', false, initial.runtimes)
  expect(refreshed.models[0].reasoningEffort).toBe('high')
  expect(refreshed.models[0].supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
  expect(initial.models[0].supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
})
