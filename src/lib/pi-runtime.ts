/** Match the native Pi argument allowlist; protocol, session and model stay app-owned. */
import { translate } from '@/i18n'
export function validatePiArguments(args: string[]): string | undefined {
  const switches = new Set(['--no-tools', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--approve', '--no-approve'])
  const values = new Set(['--tools', '--exclude-tools', '--extension', '--skill', '--append-system-prompt', '--system-prompt'])
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (switches.has(flag)) continue
    if (values.has(flag)) {
      const value = args[++index]
      if (value && !value.startsWith('-')) continue
      return translate(`Pi 参数 ${flag} 缺少有效值。`, `Pi argument ${flag} needs a valid value.`)
    }
    return translate(`Pi 适配器不支持额外参数 ${flag}；模型、会话和协议由应用管理。`, `The Pi adapter does not support argument ${flag}; the app manages model, session, and protocol settings.`)
  }
}
