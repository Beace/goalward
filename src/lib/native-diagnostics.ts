import type { Language } from '@/i18n'

// These strings are emitted by the native discovery commands. Translate only
// known diagnostics at the view boundary; the scan report remains untouched.
const diagnosticEn: Record<string, string> = {
  'Runtime 检测未能完成': 'Runtime detection could not complete.',
  '本机检测任务未能完成，请重试': 'The local scan could not complete. Please try again.',
  '尚未接入此 Runtime 的模型配置格式，请在设置中添加模型与启动参数': 'This runtime’s model configuration format is not supported yet. Add models and launch arguments in Settings.',
  '模型来自配置、缓存或 CLI 列表，尚未验证实际可调用性': 'Models came from configuration, cache, or a CLI list. Their availability has not been verified.',
  '模型条目过多，仅显示前 256 个': 'Too many model entries; only the first 256 are shown.',
  'Profile 过多，仅检查前 128 个及当前选中项': 'Too many profiles; only the first 128 and the selected profile were checked.',
  'config.toml 指定的 profile 不存在，默认模型需确认': 'The profile selected in config.toml does not exist. Confirm the default model.',
  '仅检查用户级配置；项目配置、托管策略和启动参数可能覆盖默认模型': 'Only user configuration was checked. Project settings, managed policies, or launch arguments may override the default model.',
  '进程环境和 settings.json 指定了不同默认模型，保留 Runtime 自身选择': 'The process environment and settings.json specify different default models. The runtime will choose its own default.',
  '仅检查用户级配置和已继承的模型环境变量；项目或托管配置可能覆盖，未读取 shell 启动文件': 'Only user configuration and inherited model environment variables were checked. Project or managed settings may override them; shell startup files were not read.',
  'Kimi 默认模型别名不在 models 中，请在 Kimi CLI 中修复配置': 'The Kimi default model alias is not in models. Fix the configuration in Kimi CLI.',
  'Kimi Code config.toml 模型配置无法解析': 'Could not parse the Kimi Code models in config.toml.',
  '使用 Kimi Code CLI 的 ACP 协议；执行前确认手动审批模式。模型与思考设置默认继承 Runtime，旧 Python kimi-cli 不兼容': 'Uses the Kimi Code CLI ACP protocol. Confirm manual approval mode before running. Model and reasoning settings inherit the runtime defaults; the legacy Python kimi-cli is incompatible.',
  'DSH 配置包含标签或引用语法，已跳过自动解析；请手动添加模型': 'The DSH configuration contains tags or reference syntax. Automatic parsing was skipped; add models manually.',
  '仅发现 settings.yaml 显式模型；Profile / 插件目录及 Provider 路由需在启动参数中配置': 'Only explicit models in settings.yaml were found. Configure profiles, plugin directories, and provider routing in launch arguments.',
  'Pi 模型列表格式无法识别，保留配置文件中的模型': 'The Pi model list format was not recognized. Models from configuration were retained.',
  'Pi 模型使用 provider/model 标识；思考强度继承 Pi。扫描不加载扩展，扩展注册的模型请手动添加；项目配置可能覆盖默认值': 'Pi models use provider/model IDs and inherit Pi reasoning settings. The scan does not load extensions; add extension models manually. Project settings may override defaults.',
  'TraeX 不再支持顶层 profile / profiles 配置；请通过 --profile 和 <name>.traecli.toml 选择，未标记默认模型': 'TraeX no longer supports top-level profile / profiles settings. Select one with --profile and <name>.traecli.toml. No default model was marked.',
  'TraeX model_provider 格式无法识别，已跳过模型目录与缓存查询': 'The TraeX model_provider format was not recognized. Model catalog and cache queries were skipped.',
  'TraeX CLI 当前返回空模型列表': 'TraeX CLI returned an empty model list.',
  'TraeX 模型列表 JSON 无法解析，尝试本机缓存': 'Could not parse the TraeX model list JSON; trying the local cache.',
  'TraeX 默认模型来自用户级配置；与 Codex 共用执行协议，自动传入消息并续接任务会话': 'The TraeX default model comes from user configuration. It shares the Codex execution protocol and resumes task sessions.',
  'TraeX Profile 过多，仅检查前 128 个': 'Too many TraeX profiles; only the first 128 were checked.',
  '当前平台暂不支持 Pi 模型查询': 'Pi model queries are not supported on this platform.',
  '无法启动 Pi 模型查询': 'Could not start the Pi model query.',
  '无法读取 Pi 模型查询结果': 'Could not read the Pi model query result.',
  'Pi 模型查询超时': 'The Pi model query timed out.',
  'Pi 模型查询未成功完成': 'The Pi model query did not complete successfully.',
  '无法获取 Pi 模型查询状态': 'Could not get the Pi model query status.',
  'Pi 模型查询结果超过大小限制': 'The Pi model query result exceeds the size limit.',
  'Pi 模型查询结果不是有效的 UTF-8 文本': 'The Pi model query result is not valid UTF-8 text.',
  '当前平台暂不支持 TraeX 模型查询': 'TraeX model queries are not supported on this platform.',
  '无法启动 TraeX 模型查询': 'Could not start the TraeX model query.',
  '无法读取 TraeX 模型查询结果': 'Could not read the TraeX model query result.',
  'TraeX 模型查询超时': 'The TraeX model query timed out.',
  'TraeX 模型查询未成功完成': 'The TraeX model query did not complete successfully.',
  '无法获取 TraeX 模型查询状态': 'Could not get the TraeX model query status.',
  'TraeX 模型查询结果超过大小限制': 'The TraeX model query result exceeds the size limit.',
  'TraeX 模型查询结果不是有效的 UTF-8 文本': 'The TraeX model query result is not valid UTF-8 text.',
}

const diagnosticPrefixes = [
  ['无法读取配置文件：', 'Could not read configuration file: '],
  ['跳过非普通文件或超过 2 MiB 的配置：', 'Skipped a non-regular or over-2 MiB configuration file: '],
  ['配置读取失败或超过大小限制：', 'Could not read configuration or it exceeded the size limit: '],
  ['配置不是有效 UTF-8：', 'Configuration is not valid UTF-8: '],
  ['JSON 模型配置无法解析：', 'Could not parse JSON model configuration: '],
  ['TOML 模型配置无法解析：', 'Could not parse TOML model configuration: '],
  ['YAML 模型配置无法解析：', 'Could not parse YAML model configuration: '],
  ['TraeX TOML 模型配置无法解析：', 'Could not parse TraeX TOML model configuration: '],
] as const

/** Localize a native diagnostic without changing the original report or event. */
export function localizeNativeDiagnostic(message: string, language: Language): string {
  if (language !== 'en') return message
  const exact = Object.hasOwn(diagnosticEn, message) ? diagnosticEn[message] : undefined
  if (exact) return exact
  for (const [prefix, replacement] of diagnosticPrefixes) {
    if (message.startsWith(prefix)) return replacement + message.slice(prefix.length)
  }
  const legacyProfile = /^TraeX Profile (.+) 包含旧版 profile 配置，已跳过$/.exec(message)
  if (legacyProfile) return `TraeX profile ${legacyProfile[1]} uses a legacy profile configuration and was skipped.`
  const otherProvider = /^TraeX Profile (.+) 使用不同 provider，未合并其模型；请通过启动参数选择$/.exec(message)
  if (otherProvider) return `TraeX profile ${otherProvider[1]} uses another provider. Its models were not merged; select it with launch arguments.`
  const cacheSuffix = '，尝试本机缓存'
  if (message.endsWith(cacheSuffix)) {
    const cause = localizeNativeDiagnostic(message.slice(0, -cacheSuffix.length), language).replace(/[.!?]$/, '')
    return `${cause}; trying the local cache.`
  }
  return message
}

const sourceEn: Record<string, string> = {
  'config.toml / 当前 profile': 'config.toml / current profile',
  'config.toml / profiles.已配置 profile.model': 'config.toml / profiles.configured profile.model',
  'models_cache.json / 缓存': 'models_cache.json / cache',
  '本机模型目录': 'Local model catalog',
  'Claude Code / 当前模型配置': 'Claude Code / current model configuration',
  'settings.yaml / llm-pi-ai.providers.已配置 provider': 'settings.yaml / llm-pi-ai.providers.configured provider',
  '已配置 profile': 'configured profile',
  '已配置 provider': 'configured provider',
}

/** Source labels are native UI metadata; model IDs, names, paths and sources stay raw in storage. */
export function localizeNativeModelSource(source: string, language: Language): string {
  if (language !== 'en') return source
  return source.split(' · ').map(part => {
    if (Object.hasOwn(sourceEn, part)) return sourceEn[part]
    if (part.startsWith('进程环境 / ')) return 'Process environment / ' + part.slice('进程环境 / '.length)
    const cache = /^(models_cache\.json \/ .+ \/ )缓存$/.exec(part)
    if (cache) return cache[1] + 'cache'
    const candidate = /^(.+\.traecli\.toml) \/ 候选（--profile (.+)）$/.exec(part)
    if (candidate) return `${candidate[1]} / candidate (--profile ${candidate[2]})`
    return part
  }).join(' · ')
}
