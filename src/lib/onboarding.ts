import { createInitialState } from './domain'
import type { AppState, DiscoveredModel, DiscoveredRuntime, LocalDiscoveryReport, ModelConfig, RuntimeConfig, Settings } from './types'

// Rust's JSON maps may reorder object keys on disk. Configuration identity is
// structural; an unchanged saved runtime must remain eligible for discovery.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
const equalConfig = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

export function canConfigureTask(runtime: RuntimeConfig): boolean {
  return runtime.enabled && Boolean(runtime.executable.trim())
    && (runtime.adapter !== 'generic' || runtime.args.some(arg => arg.includes('{prompt}')))
}

/** Only the untouched starter defaults may be disabled based on an initial scan. */
export function hasStarterSettings(state: AppState): boolean {
  return !state.onboarding && state.tasks.every(task => task.demo)
    && equalConfig(state.settings, createInitialState().settings)
}

export function sameDiscoveredInstallation(runtime: RuntimeConfig, found: DiscoveredRuntime): boolean {
  return runtime.adapter === found.adapter
    && [found.executable, found.probe.path].includes(runtime.executable.trim())
}

function matchesDiscoveredModel(model: ModelConfig, found: DiscoveredModel, runtimeId: string): boolean {
  return model.runtimeIds.includes(runtimeId)
    && (model.modelId === found.modelId || found.aliases?.includes(model.modelId) === true)
}

function refreshReasoningCapabilities(model: ModelConfig, found: DiscoveredModel, runtime: DiscoveredRuntime) {
  if (found.supportedReasoningEfforts === undefined) return
  if (runtime.adapter === 'codex' || runtime.adapter === 'kimi') {
    model.supportedReasoningEffortsByRuntime = {
      ...model.supportedReasoningEffortsByRuntime,
      [runtime.id]: [...found.supportedReasoningEfforts],
    }
    // Preserve the legacy Codex catalog field without allowing Kimi aliases to
    // replace capabilities used by a different runtime on this shared model.
    if (runtime.adapter === 'codex') model.supportedReasoningEfforts = [...found.supportedReasoningEfforts]
  }
}

export function discoveryManagedIds(settings: Settings, managed: RuntimeConfig[] = []): string[] {
  const defaults = createInitialState().settings.runtimes
  return settings.runtimes.filter(runtime => [...defaults, ...managed].some(previous => previous.id === runtime.id
    && equalConfig(previous, runtime))).map(runtime => runtime.id)
}

export function mergeLocalDiscovery(
  settings: Settings,
  report: LocalDiscoveryReport,
  selectedIds: string[],
  preferredId: string,
  replaceStarter = false,
  managedRuntimes: RuntimeConfig[] = [],
): Settings {
  const selected = report.runtimes.filter(item => selectedIds.includes(item.id) && item.probe.found)
  const next = structuredClone(settings)
  const starter = createInitialState().settings
  const managed = new Set(discoveryManagedIds(settings, managedRuntimes))
  if (replaceStarter) {
    next.runtimes = next.runtimes.map(runtime => ({ ...runtime, enabled: false }))
    next.defaultRuntime = ''
  }
  const adoptDefaults: string[] = []
  for (const found of selected) {
    const original = settings.runtimes.find(runtime => runtime.id === found.id)
    const template = starter.runtimes.find(runtime => runtime.id === found.id)
    // Existing custom paths, arguments, enabled state and model choices belong to the user.
    const untouched = !original || managed.has(found.id)
    if (untouched) {
      const runtime: RuntimeConfig = {
        ...(template ?? { id: found.id, name: found.name, description: '', args: [], defaultModel: '' }),
        executable: found.probe.path || found.executable,
        adapter: found.adapter,
        enabled: !found.probe.error && found.adapter !== 'generic',
      }
      const index = next.runtimes.findIndex(item => item.id === found.id)
      if (index >= 0) next.runtimes[index] = runtime
      else next.runtimes.push(runtime)
      adoptDefaults.push(found.id)
    }
    const runtime = next.runtimes.find(item => item.id === found.id)!
    if (!sameDiscoveredInstallation(runtime, found)) continue
    for (const model of found.models) {
      if (!model.modelId.trim()) continue
      const existing = next.models.find(item => matchesDiscoveredModel(item, model, found.id))
      if (existing) {
        // Capability metadata may refresh; manually chosen defaults stay untouched.
        refreshReasoningCapabilities(existing, model, found)
        continue
      }
      const reusable = next.models.find(item => item.modelId === model.modelId && item.providerId === '')
      if (reusable) { reusable.runtimeIds.push(found.id); refreshReasoningCapabilities(reusable, model, found) }
      else {
        const entry: ModelConfig = { id: crypto.randomUUID(), modelId: model.modelId, name: model.name || model.modelId, providerId: '', runtimeIds: [found.id], enabled: true }
        if (found.adapter !== 'kimi' && model.supportedReasoningEfforts !== undefined) entry.supportedReasoningEfforts = [...model.supportedReasoningEfforts]
        refreshReasoningCapabilities(entry, model, found)
        next.models.push(entry)
      }
    }
    if (adoptDefaults.includes(found.id)) {
      const model = found.models.filter(item => item.selected)
        .map(item => next.models.find(entry => entry.enabled && matchesDiscoveredModel(entry, item, found.id)))
        .find(item => item !== undefined)
      runtime.defaultModel = model?.modelId ?? ''
    }
  }
  const runnable = next.runtimes.filter(canConfigureTask)
  // An explicit user choice may change the default; otherwise preserve their default.
  if (preferredId && selectedIds.includes(preferredId) && runnable.some(runtime => runtime.id === preferredId)) next.defaultRuntime = preferredId
  if (!runnable.some(runtime => runtime.id === next.defaultRuntime)) next.defaultRuntime = runnable[0]?.id ?? ''
  return next
}
