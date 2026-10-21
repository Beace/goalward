import type { Language } from '@/i18n'

const SEPARATOR = '\u001f'

type Text = readonly [zh: string, en: string]

// Codes are the stable payload from Rust. Chinese text remains only so scans
// saved before these codes still render in the selected language.
const staticDiagnostics: Record<string, Text> = {
  runtime_probe_incomplete: ['Runtime 检测未能完成', 'Runtime detection could not complete.'],
  local_scan_failed: ['本机检测任务未能完成，请重试', 'The local scan could not complete. Please try again.'],
  runtime_model_format_unsupported: ['尚未接入此 Runtime 的模型配置格式，请在设置中添加模型与启动参数', 'This runtime’s model configuration format is not supported yet. Add models and launch arguments in Settings.'],
  models_unverified: ['模型来自配置、缓存或 CLI 列表，尚未验证实际可调用性', 'Models came from configuration, cache, or a CLI list. Their availability has not been verified.'],
  too_many_models: ['模型条目过多，仅显示前 256 个', 'Too many model entries; only the first 256 are shown.'],
  too_many_profiles: ['Profile 过多，仅检查前 128 个及当前选中项', 'Too many profiles; only the first 128 and the selected profile were checked.'],
  codex_profile_missing: ['config.toml 指定的 profile 不存在，默认模型需确认', 'The profile selected in config.toml does not exist. Confirm the default model.'],
  codex_user_config_only: ['仅检查用户级配置；项目配置、托管策略和启动参数可能覆盖默认模型', 'Only user configuration was checked. Project settings, managed policies, or launch arguments may override the default model.'],
  claude_model_conflict: ['进程环境和 settings.json 指定了不同默认模型，保留 Runtime 自身选择', 'The process environment and settings.json specify different default models. The runtime will choose its own default.'],
  claude_user_config_only: ['仅检查用户级配置和已继承的模型环境变量；项目或托管配置可能覆盖，未读取 shell 启动文件', 'Only user configuration and inherited model environment variables were checked. Project or managed settings may override them; shell startup files were not read.'],
  kimi_default_alias_missing: ['Kimi 默认模型别名不在 models 中，请在 Kimi CLI 中修复配置', 'The Kimi default model alias is not in models. Fix the configuration in Kimi CLI.'],
  kimi_config_invalid: ['Kimi Code config.toml 模型配置无法解析', 'Could not parse the Kimi Code models in config.toml.'],
  kimi_acp_note: ['使用 Kimi Code CLI 的 ACP 协议；执行前确认手动审批模式。模型与思考设置默认继承 Runtime，旧 Python kimi-cli 不兼容', 'Uses the Kimi Code CLI ACP protocol. Confirm manual approval mode before running. Model and reasoning settings inherit the runtime defaults; the legacy Python kimi-cli is incompatible.'],
  dsh_advanced_yaml: ['DSH 配置包含标签或引用语法，已跳过自动解析；请手动添加模型', 'The DSH configuration contains tags or reference syntax. Automatic parsing was skipped; add models manually.'],
  dsh_explicit_models_only: ['仅发现 settings.yaml 显式模型；Profile / 插件目录及 Provider 路由需在启动参数中配置', 'Only explicit models in settings.yaml were found. Configure profiles, plugin directories, and provider routing in launch arguments.'],
  pi_model_list_unrecognized: ['Pi 模型列表格式无法识别，保留配置文件中的模型', 'The Pi model list format was not recognized. Models from configuration were retained.'],
  pi_model_note: ['Pi 模型使用 provider/model 标识；思考强度继承 Pi。扫描不加载扩展，扩展注册的模型请手动添加；项目配置可能覆盖默认值', 'Pi models use provider/model IDs and inherit Pi reasoning settings. The scan does not load extensions; add extension models manually. Project settings may override defaults.'],
  traex_legacy_profiles: ['TraeX 不再支持顶层 profile / profiles 配置；请通过 --profile 和 <name>.traecli.toml 选择，未标记默认模型', 'TraeX no longer supports top-level profile / profiles settings. Select one with --profile and <name>.traecli.toml. No default model was marked.'],
  traex_provider_unrecognized: ['TraeX model_provider 格式无法识别，已跳过模型目录与缓存查询', 'The TraeX model_provider format was not recognized. Model catalog and cache queries were skipped.'],
  traex_empty_model_list: ['TraeX CLI 当前返回空模型列表', 'TraeX CLI returned an empty model list.'],
  traex_model_list_invalid: ['TraeX 模型列表 JSON 无法解析，尝试本机缓存', 'Could not parse the TraeX model list JSON; trying the local cache.'],
  traex_user_config_note: ['TraeX 默认模型来自用户级配置；与 Codex 共用执行协议，自动传入消息并续接任务会话', 'The TraeX default model comes from user configuration. It shares the Codex execution protocol and resumes task sessions.'],
  traex_too_many_profiles: ['TraeX Profile 过多，仅检查前 128 个', 'Too many TraeX profiles; only the first 128 were checked.'],
  pi_query_unsupported: ['当前平台暂不支持 Pi 模型查询', 'Pi model queries are not supported on this platform.'],
  pi_query_start_failed: ['无法启动 Pi 模型查询', 'Could not start the Pi model query.'],
  pi_query_read_failed: ['无法读取 Pi 模型查询结果', 'Could not read the Pi model query result.'],
  pi_query_timeout: ['Pi 模型查询超时', 'The Pi model query timed out.'],
  pi_query_failed: ['Pi 模型查询未成功完成', 'The Pi model query did not complete successfully.'],
  pi_query_status_failed: ['无法获取 Pi 模型查询状态', 'Could not get the Pi model query status.'],
  pi_query_too_large: ['Pi 模型查询结果超过大小限制', 'The Pi model query result exceeds the size limit.'],
  pi_query_invalid_utf8: ['Pi 模型查询结果不是有效的 UTF-8 文本', 'The Pi model query result is not valid UTF-8 text.'],
  traex_query_unsupported: ['当前平台暂不支持 TraeX 模型查询', 'TraeX model queries are not supported on this platform.'],
  traex_query_start_failed: ['无法启动 TraeX 模型查询', 'Could not start the TraeX model query.'],
  traex_query_read_failed: ['无法读取 TraeX 模型查询结果', 'Could not read the TraeX model query result.'],
  traex_query_timeout: ['TraeX 模型查询超时', 'The TraeX model query timed out.'],
  traex_query_failed: ['TraeX 模型查询未成功完成', 'The TraeX model query did not complete successfully.'],
  traex_query_status_failed: ['无法获取 TraeX 模型查询状态', 'Could not get the TraeX model query status.'],
  traex_query_too_large: ['TraeX 模型查询结果超过大小限制', 'The TraeX model query result exceeds the size limit.'],
  traex_query_invalid_utf8: ['TraeX 模型查询结果不是有效的 UTF-8 文本', 'The TraeX model query result is not valid UTF-8 text.'],
}

const detailDiagnostics: Record<string, (detail: string, language: Language) => string> = {
  config_read_failed: (detail, language) => language === 'zh' ? `无法读取配置文件：${detail}` : `Could not read configuration file: ${detail}`,
  config_skipped: (detail, language) => language === 'zh' ? `跳过非普通文件或超过 2 MiB 的配置：${detail}` : `Skipped a non-regular or over-2 MiB configuration file: ${detail}`,
  config_too_large: (detail, language) => language === 'zh' ? `配置读取失败或超过大小限制：${detail}` : `Could not read configuration or it exceeded the size limit: ${detail}`,
  config_invalid_utf8: (detail, language) => language === 'zh' ? `配置不是有效 UTF-8：${detail}` : `Configuration is not valid UTF-8: ${detail}`,
  json_model_config_invalid: (detail, language) => language === 'zh' ? `JSON 模型配置无法解析：${detail}` : `Could not parse JSON model configuration: ${detail}`,
  toml_model_config_invalid: (detail, language) => language === 'zh' ? `TOML 模型配置无法解析：${detail}` : `Could not parse TOML model configuration: ${detail}`,
  yaml_model_config_invalid: (detail, language) => language === 'zh' ? `YAML 模型配置无法解析：${detail}` : `Could not parse YAML model configuration: ${detail}`,
  traex_toml_invalid: (detail, language) => language === 'zh' ? `TraeX TOML 模型配置无法解析：${detail}` : `Could not parse TraeX TOML model configuration: ${detail}`,
  traex_legacy_profile: (name, language) => language === 'zh' ? `TraeX Profile ${name} 包含旧版 profile 配置，已跳过` : `TraeX profile ${name} uses a legacy profile configuration and was skipped.`,
  traex_profile_other_provider: (name, language) => language === 'zh' ? `TraeX Profile ${name} 使用不同 provider，未合并其模型；请通过启动参数选择` : `TraeX profile ${name} uses another provider. Its models were not merged; select it with launch arguments.`,
  trying_local_cache: (cause, language) => {
    const localized = localizeNativeDiagnostic(cause, language).replace(/[.!?]$/, '')
    return language === 'zh' ? `${localized}，尝试本机缓存` : `${localized}; trying the local cache.`
  },
}

const legacyExact: Record<string, string> = Object.fromEntries(Object.values(staticDiagnostics).map(([zh, en]) => [zh, en]))

const legacyPrefixes = [
  ['无法读取配置文件：', 'Could not read configuration file: '],
  ['跳过非普通文件或超过 2 MiB 的配置：', 'Skipped a non-regular or over-2 MiB configuration file: '],
  ['配置读取失败或超过大小限制：', 'Could not read configuration or it exceeded the size limit: '],
  ['配置不是有效 UTF-8：', 'Configuration is not valid UTF-8: '],
  ['JSON 模型配置无法解析：', 'Could not parse JSON model configuration: '],
  ['TOML 模型配置无法解析：', 'Could not parse TOML model configuration: '],
  ['YAML 模型配置无法解析：', 'Could not parse YAML model configuration: '],
  ['TraeX TOML 模型配置无法解析：', 'Could not parse TraeX TOML model configuration: '],
] as const

const sourceStatic: Record<string, Text> = {
  codex_current_profile: ['config.toml / 当前 profile', 'config.toml / current profile'],
  configured_profile: ['已配置 profile', 'configured profile'],
  local_model_catalog: ['本机模型目录', 'Local model catalog'],
  codex_model_cache: ['models_cache.json / 缓存', 'models_cache.json / cache'],
  claude_current_model: ['Claude Code / 当前模型配置', 'Claude Code / current model configuration'],
  configured_provider: ['已配置 provider', 'configured provider'],
}

const sourceDetail: Record<string, (detail: string, language: Language) => string> = {
  codex_profile_model: (label, language) => `config.toml / profiles.${localizeSourcePart(label, language)}.model`,
  process_env: (key, language) => language === 'zh' ? `进程环境 / ${key}` : `Process environment / ${key}`,
  dsh_provider: (provider, language) => `settings.yaml / llm-pi-ai.providers.${localizeSourcePart(provider, language)}`,
  traex_profile_candidate: (name, language) => language === 'zh' ? `${name}.traecli.toml / 候选（--profile ${name}）` : `${name}.traecli.toml / candidate (--profile ${name})`,
  traex_model_cache: (provider, language) => language === 'zh' ? `models_cache.json / ${provider} / 缓存` : `models_cache.json / ${provider} / cache`,
}

const legacySources: Record<string, string> = {
  'config.toml / 当前 profile': 'config.toml / current profile',
  'config.toml / profiles.已配置 profile.model': 'config.toml / profiles.configured profile.model',
  'models_cache.json / 缓存': 'models_cache.json / cache',
  '本机模型目录': 'Local model catalog',
  'Claude Code / 当前模型配置': 'Claude Code / current model configuration',
  'settings.yaml / llm-pi-ai.providers.已配置 provider': 'settings.yaml / llm-pi-ai.providers.configured provider',
  '已配置 profile': 'configured profile',
  '已配置 provider': 'configured provider',
}

export const nativeDiagnosticCodes = new Set(Object.keys(staticDiagnostics))
export const nativeDiagnosticDetailCodes = new Set(Object.keys(detailDiagnostics))
export const nativeSourceCodes = new Set(Object.keys(sourceStatic))
export const nativeSourceDetailCodes = new Set(Object.keys(sourceDetail))

function coded(message: string): { code: string; detail?: string } | undefined {
  const index = message.indexOf(SEPARATOR)
  const code = index === -1 ? message : message.slice(0, index)
  if (!/^[a-z0-9_]+$/.test(code)) return undefined
  return { code, detail: index === -1 ? undefined : message.slice(index + 1) }
}

function text(entry: Text, language: Language): string {
  return language === 'zh' ? entry[0] : entry[1]
}

function localizeStructuredDiagnostic(message: string, language: Language): string | undefined {
  const parsed = coded(message)
  if (!parsed) return undefined
  if (parsed.detail === undefined) {
    return Object.hasOwn(staticDiagnostics, parsed.code) ? text(staticDiagnostics[parsed.code], language) : undefined
  }
  const render = Object.hasOwn(detailDiagnostics, parsed.code) ? detailDiagnostics[parsed.code] : undefined
  return render?.(parsed.detail, language)
}

function localizeLegacyDiagnostic(message: string): string | undefined {
  const exact = Object.hasOwn(legacyExact, message) ? legacyExact[message] : undefined
  if (exact) return exact
  for (const [prefix, replacement] of legacyPrefixes) {
    if (message.startsWith(prefix)) return replacement + message.slice(prefix.length)
  }
  const legacyProfile = /^TraeX Profile (.+) 包含旧版 profile 配置，已跳过$/.exec(message)
  if (legacyProfile) return `TraeX profile ${legacyProfile[1]} uses a legacy profile configuration and was skipped.`
  const otherProvider = /^TraeX Profile (.+) 使用不同 provider，未合并其模型；请通过启动参数选择$/.exec(message)
  if (otherProvider) return `TraeX profile ${otherProvider[1]} uses another provider. Its models were not merged; select it with launch arguments.`
  const cacheSuffix = '，尝试本机缓存'
  if (message.endsWith(cacheSuffix)) {
    const cause = localizeNativeDiagnostic(message.slice(0, -cacheSuffix.length), 'en').replace(/[.!?]$/, '')
    return `${cause}; trying the local cache.`
  }
  return undefined
}

/** Localize a native diagnostic without changing the original report or event. */
export function localizeNativeDiagnostic(message: string, language: Language): string {
  const normalized = message.trim().replace(/^Error:\s*/, '')
  const structured = localizeStructuredDiagnostic(normalized, language)
  if (structured !== undefined) return structured
  if (language === 'en') {
    const legacy = localizeLegacyDiagnostic(normalized)
    if (legacy !== undefined) return legacy
  }
  return message
}

function localizeSourcePart(part: string, language: Language): string {
  const parsed = coded(part)
  if (parsed?.detail === undefined && parsed && Object.hasOwn(sourceStatic, parsed.code)) return text(sourceStatic[parsed.code], language)
  if (parsed?.detail !== undefined && Object.hasOwn(sourceDetail, parsed.code)) return sourceDetail[parsed.code](parsed.detail, language)
  if (language !== 'en') return part
  if (Object.hasOwn(legacySources, part)) return legacySources[part]
  if (part.startsWith('进程环境 / ')) return 'Process environment / ' + part.slice('进程环境 / '.length)
  const cache = /^(models_cache\.json \/ .+ \/ )缓存$/.exec(part)
  if (cache) return cache[1] + 'cache'
  const candidate = /^(.+\.traecli\.toml) \/ 候选（--profile (.+)）$/.exec(part)
  if (candidate) return `${candidate[1]} / candidate (--profile ${candidate[2]})`
  return part
}

/** Source labels are native UI metadata; model IDs, names, paths and sources stay raw in storage. */
export function localizeNativeModelSource(source: string, language: Language): string {
  return source.split(' · ').map(part => localizeSourcePart(part, language)).join(' · ')
}
