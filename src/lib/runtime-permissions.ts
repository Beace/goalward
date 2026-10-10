import { validatePiArguments } from './pi-runtime'
import { translate } from '@/i18n'
import type { RuntimeConfig } from './types'

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128 && value.every(item => typeof item === 'string' && new TextEncoder().encode(item).length <= 4096 && !item.includes('\0'))
const directories = (value: unknown): value is string[] => stringList(value) && value.every(path => path.startsWith('/') && path.trim() === path)

/** Immediate form validation. Native validation remains authoritative before any process starts. */
export function validateRuntimePermissions(runtime: RuntimeConfig): string | undefined {
  if (runtime.adapter === 'pi') return validatePiArguments(runtime.args)
  if (runtime.adapter === 'kimi' && runtime.args.length) return translate('Kimi ACP 适配器不接受额外启动参数；请选择模型或修改 Kimi 自身配置。', 'The Kimi ACP adapter does not accept extra launch arguments. Select a model or change Kimi’s own configuration.')
  const permissions: unknown = runtime.permissions
  if (permissions === undefined) return
  if (!object(permissions)) return translate('权限配置格式无效，请重新配置此 Runtime。', 'Invalid permission settings. Configure this runtime again.')
  const value = permissions[runtime.adapter]
  if (value === undefined) return
  if (!object(value)) return translate('权限配置格式无效，请重新配置此 Runtime。', 'Invalid permission settings. Configure this runtime again.')
  if (runtime.adapter === 'codex') {
    if (!['inherit', 'read-only', 'workspace-write', 'danger-full-access'].includes(String(value.sandbox))) return translate('请选择有效的 Codex 文件访问模式。', 'Choose a valid Codex file-access mode.')
    if (!['inherit', 'deny', 'allow'].includes(String(value.network))) return translate('请选择有效的 Codex 网络策略。', 'Choose a valid Codex network policy.')
    if (!directories(value.additionalDirectories)) return translate('额外目录需逐行填写绝对路径（以 / 开头），最多 128 项。', 'Enter absolute paths (starting with /), one per line, up to 128 directories.')
    if (value.sandbox !== 'workspace-write' && (value.network !== 'inherit' || value.additionalDirectories.length)) return translate('额外可写目录和命令网络策略仅适用于“工作目录可写”。', 'Extra writable directories and command network policy require Workspace write mode.')
    if (value.sandbox !== 'inherit' || value.network !== 'inherit' || value.additionalDirectories.length) {
      const conflict = codexPermissionConflict(runtime.args)
      if (conflict) return translate(`额外启动参数 ${conflict} 会覆盖访问权限，请移除冲突参数或改为继承 Runtime 配置。`, `Launch argument ${conflict} overrides access permissions. Remove it or inherit runtime settings.`)
    }
  } else if (runtime.adapter === 'claude') {
    if (!['inherit', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(String(value.mode))) return translate('请选择有效的 Claude Code 权限模式。', 'Choose a valid Claude Code permission mode.')
    if (!directories(value.additionalDirectories)) return translate('额外目录需逐行填写绝对路径（以 / 开头），最多 128 项。', 'Enter absolute paths (starting with /), one per line, up to 128 directories.')
    if (!stringList(value.allowedTools) || !stringList(value.disallowedTools) || [...value.allowedTools, ...value.disallowedTools].some(rule => !rule.trim() || rule.startsWith('-') || /[\r\n]/.test(rule))) return translate('工具规则需逐行填写，不能以 - 开头或包含空规则。', 'Enter tool rules one per line; rules cannot start with - or be empty.')
    if (value.mode !== 'inherit' || value.additionalDirectories.length || value.allowedTools.length || value.disallowedTools.length) {
      const conflict = runtime.args.find(arg => claudePermissionFlags.has(arg.split('=')[0]))
      if (conflict) return translate(`额外启动参数 ${conflict.split('=')[0]} 会覆盖访问权限，请移除冲突参数或改为继承 Runtime 配置。`, `Launch argument ${conflict.split('=')[0]} overrides access permissions. Remove it or inherit runtime settings.`)
    }
  } else if (runtime.adapter === 'kimi') {
    if (!['auto', 'manual'].includes(String(value.mode))) return translate('请选择有效的 Kimi 审批模式。', 'Choose a valid Kimi approval mode.')
  } else if (!stringList(value.args)) return translate('权限参数必须是 JSON 字符串数组，最多 128 项。', 'Permission arguments must be a JSON string array with no more than 128 items.')
}

export function hasLegacyPermissionOverrides(runtime: RuntimeConfig): boolean {
  return runtime.adapter === 'codex' ? Boolean(codexPermissionConflict(runtime.args))
    : runtime.args.some(arg => claudePermissionFlags.has(arg.split('=')[0]))
}

const codexPermissionFlags = new Set(['--sandbox', '-s', '--add-dir', '--approve-for-me', '--not-so-yolo', '--full-auto', '--yolo', '--ask-for-approval', '-a', '--profile', '-p', '--cd', '-C', '--ignore-user-config', '--ignore-rules', '--enable', '--disable', '--'])
const claudePermissionFlags = new Set(['--permission-mode', '--permission-prompts', '--permission-prompt-tool', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--add-dir', '--tools', '--settings', '--setting-sources', '--restricted', '--bare', '--safe-mode', '--'])
const permissionKeys = ['sandbox', 'sandbox_mode', 'sandbox_permissions', 'sandbox_workspace_write', 'sandbox_read_only', 'approval_policy', 'approvals_reviewer', 'permissions', 'permission_profile', 'features', 'profiles', 'profile', 'projects', 'default_permissions', 'forced_auto_mode', 'cwd', 'experimental_use_profile', 'use_legacy_landlock']

export function codexPermissionConflict(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flag = arg.split('=')[0]
    if (codexPermissionFlags.has(flag) || flag.startsWith('--dangerously-') || /^-[sapC].+/.test(arg)) return flag
    let config: string | undefined
    if (arg === '-c' || arg === '--config') config = args[++i]
    else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
    else if (arg.startsWith('-c')) config = arg.slice(2).replace(/^=/, '')
    if (config !== undefined) {
      const key = config.split('=')[0].trim().replace(/["']/g, '')
      if (permissionKeys.some(root => key === root || key.startsWith(`${root}.`))) return translate('--config（权限相关项）', '--config (permission-related setting)')
    }
  }
}
