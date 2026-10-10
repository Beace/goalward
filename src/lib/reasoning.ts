import type { Member, ModelConfig, ReasoningEffort, RuntimeConfig } from './types'
import { translate } from '@/i18n'

export const reasoningEfforts: ReasoningEffort[] = ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const labels: Record<ReasoningEffort, string> = {
  inherit: 'Runtime 默认', none: '不启用 · none', minimal: '最低 · minimal', low: '低 · low',
  medium: '中 · medium', high: '高 · high', xhigh: '超高 · xhigh', max: '最高 · max', ultra: '极高 · ultra',
}
const labelsEn: Record<ReasoningEffort, string> = {
  inherit: 'Runtime default', none: 'Disabled · none', minimal: 'Minimal · minimal', low: 'Low · low',
  medium: 'Medium · medium', high: 'High · high', xhigh: 'Extra high · xhigh', max: 'Maximum · max', ultra: 'Ultra · ultra',
}
export function reasoningLabel(value: ReasoningEffort): string { return translate(labels[value] ?? String(value), labelsEn[value] ?? String(value)) }

// Compatibility fallback for existing catalog entries. Verified against the local
// Codex catalog on 2026-09-16; newly discovered metadata takes precedence.
const codexCatalog: Record<string, ReasoningEffort[]> = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
}
const claudeEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function discoveredEfforts(runtime: RuntimeConfig, model?: ModelConfig) {
  const scoped = model?.supportedReasoningEffortsByRuntime
  if (scoped && typeof scoped === 'object' && !Array.isArray(scoped) && Object.hasOwn(scoped, runtime.id)) {
    // A scoped empty list is authoritative; invalid saved metadata must not fall back.
    return Array.isArray(scoped[runtime.id]) ? scoped[runtime.id] : []
  }
  // Legacy Codex metadata was not scoped. Legacy Kimi values are unambiguous only
  // while the entry is bound to that one runtime; shared models require discovery.
  if (runtime.adapter === 'codex' || (model?.runtimeIds.length === 1 && model.runtimeIds[0] === runtime.id)) return model?.supportedReasoningEfforts
}

export function getReasoningOptions(runtime: RuntimeConfig | undefined, model?: ModelConfig) {
  let values: ReasoningEffort[] = []
  if (runtime?.adapter === 'codex') {
    const metadata = discoveredEfforts(runtime, model)
    values = Array.isArray(metadata)
      ? metadata.filter(value => reasoningEfforts.includes(value) && (value as string) !== 'inherit')
      : codexCatalog[model?.modelId ?? runtime.defaultModel] ?? reasoningEfforts.slice(1)
  } else if (runtime?.adapter === 'claude') {
    const modelId = model?.modelId ?? runtime.defaultModel
    values = /(?:opus|sonnet)-4[-.]6(?:$|[-:])/.test(modelId) ? claudeEfforts.filter(value => value !== 'xhigh') : claudeEfforts
  } else if (runtime?.adapter === 'kimi') {
    // Kimi exposes per-model support_efforts. Missing metadata must not borrow
    // another model's choices; the ACP session validates them again before prompt.
    const metadata = discoveredEfforts(runtime, model)
    values = Array.isArray(metadata)
      ? metadata.filter(value => reasoningEfforts.includes(value) && (value as string) !== 'inherit')
      : []
  }
  return ['inherit' as const, ...new Set(values)].map(value => ({ value, label: reasoningLabel(value) }))
}

export function getModelReasoningOptions(model: ModelConfig, runtimes: RuntimeConfig[]) {
  const bound = runtimes.filter(runtime => model.runtimeIds.includes(runtime.id))
  if (!bound.length) return [{ value: 'inherit' as ReasoningEffort, label: reasoningLabel('inherit') }]
  return getReasoningOptions(bound[0], model).filter(option => bound.every(runtime => getReasoningOptions(runtime, model).some(candidate => candidate.value === option.value)))
}

export function validateModelReasoning(model: ModelConfig, runtimes: RuntimeConfig[]): string | undefined {
  const validEfforts = (value: unknown) => Array.isArray(value) && value.every(effort => effort !== 'inherit' && reasoningEfforts.includes(effort))
  const scoped = model.supportedReasoningEffortsByRuntime
  if ((model.supportedReasoningEfforts !== undefined && !validEfforts(model.supportedReasoningEfforts))
    || (scoped !== undefined && (!scoped || typeof scoped !== 'object' || Array.isArray(scoped)
      || Object.entries(scoped).some(([runtimeId, efforts]) => !runtimeId.trim() || !validEfforts(efforts))))) return translate('模型的思考强度能力数据无效，请重新检测此模型。', 'The model reasoning capability data is invalid. Detect this model again.')
  const value = model.reasoningEffort
  if (value === undefined) return
  if (!getModelReasoningOptions(model, runtimes).some(option => option.value === value)) return translate('此思考强度不适用于当前模型的全部兼容 Runtime，请选择其他档位或继承 Runtime 默认。', 'This reasoning level is not supported by all compatible runtimes. Choose another level or inherit the runtime default.')
}

export function validateReasoning(runtime: RuntimeConfig, model: ModelConfig | undefined, value: unknown): string | undefined {
  if (typeof value !== 'string' || !reasoningEfforts.includes(value as ReasoningEffort)) return translate('思考强度配置无效，请重新选择。', 'Invalid reasoning level. Choose again.')
  if (!getReasoningOptions(runtime, model).some(option => option.value === value)) return runtime.adapter === 'generic'
    ? translate('此 Runtime 使用通用适配器，思考强度请设为 Runtime 默认，并通过其 CLI 启动参数配置。', 'This runtime uses a generic adapter. Keep reasoning at Runtime default and configure it through CLI arguments.')
    : translate('当前模型或 Runtime 不支持所选思考强度，请重新选择。', 'The selected reasoning level is not supported by this model or runtime. Choose again.')
  if (value === 'inherit') return
  const conflict = reasoningArgumentConflict(runtime)
  if (conflict) return translate(`额外启动参数 ${conflict} 与显式思考强度冲突，请移除冲突参数或改为 Runtime 默认。`, `Launch argument ${conflict} conflicts with the selected reasoning level. Remove it or use Runtime default.`)
}

export function resolveReasoningEffort(member: Member, runtime: RuntimeConfig, models: ModelConfig[]): ReasoningEffort {
  const model = models.find(item => item.enabled && item.modelId === (member.modelId || runtime.defaultModel) && item.runtimeIds.includes(runtime.id))
  const modelDefault = model?.reasoningEffort === undefined ? 'inherit' : model.reasoningEffort
  const value = member.reasoningEffort === undefined ? modelDefault : member.reasoningEffort
  const error = validateReasoning(runtime, model, value)
  if (error) throw new Error(error)
  return value
}

function reasoningArgumentConflict(runtime: RuntimeConfig): string | undefined {
  for (let index = 0; index < runtime.args.length; index++) {
    const arg = runtime.args[index]
    const flag = arg.split('=')[0]
    if (arg === '--') return '--'
    if (runtime.adapter === 'claude') {
      if (['--effort', '--settings', '--setting-sources', '--model', '-m', '--fallback-model'].includes(flag) || /^-m.+/.test(arg)) return flag
    } else if (runtime.adapter === 'codex') {
      if (['--profile', '-p', '--model', '-m'].includes(flag) || /^-[pm].+/.test(arg)) return flag
      let config: string | undefined
      if (arg === '-c' || arg === '--config') config = runtime.args[++index]
      else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
      else if (arg.startsWith('-c')) config = arg.slice(2).replace(/^=/, '')
      if (config !== undefined) {
        const key = config.split('=')[0].trim().replace(/["']/g, '')
        if (['model_reasoning_effort', 'model', 'profile', 'profiles', 'experimental_use_profile'].some(root => key === root || key.startsWith(root + '.'))) return translate('--config（模型或思考强度）', '--config (model or reasoning level)')
      }
    }
  }
}
