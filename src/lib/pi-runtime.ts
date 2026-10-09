/** Match the native Pi argument allowlist; protocol, session and model stay app-owned. */
export function validatePiArguments(args: string[]): string | undefined {
  const switches = new Set(['--no-tools', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--approve', '--no-approve'])
  const values = new Set(['--tools', '--exclude-tools', '--extension', '--skill', '--append-system-prompt', '--system-prompt'])
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (switches.has(flag)) continue
    if (values.has(flag)) {
      const value = args[++index]
      if (value && !value.startsWith('-')) continue
      return `Pi 参数 ${flag} 缺少有效值。`
    }
    return `Pi 适配器不支持额外参数 ${flag}；模型、会话和协议由应用管理。`
  }
}
