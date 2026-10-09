import type { RuntimeConfig } from './types'

export const traexDescription = '使用本机 TraeX CLI 的登录与配置；与 Codex 共用执行和会话协议。'

/** Upgrade active settings only. Historical Run snapshots keep their original protocol. */
export function migrateTraexRuntime(runtime: RuntimeConfig): RuntimeConfig {
  if (runtime.id !== 'traex' || runtime.adapter !== 'generic') return runtime
  const args: string[] = []
  for (let index = 0; index < runtime.args.length; index++) {
    const arg = runtime.args[index]
    // The native adapter owns the command, output format and stdin prompt.
    if (arg === 'exec' || arg === 'e' || arg === '--json' || arg === '--skip-git-repo-check' || arg === '--' || arg === '{prompt}') continue
    if (arg === '--color') { index++; continue }
    if (arg.startsWith('--color=')) continue
    if (arg === '--prompt' && runtime.args[index + 1] === '{prompt}') { index++; continue }
    if ((arg === '--model' || arg === '-m') && runtime.args[index + 1] === '{model}') { index++; continue }
    if (arg === '--model={model}' || arg === '--prompt={prompt}') continue
    args.push(arg)
    // Keep option values intact even when a profile/model happens to be named "exec".
    if (arg.startsWith('-') && !arg.includes('=') && runtime.args[index + 1] && !runtime.args[index + 1].startsWith('-')) args.push(runtime.args[++index])
  }
  // Explicit generic permissions (including an empty list) meant to inherit
  // the CLI policy. Preserve them without introducing the adapter's defaults.
  const generic = runtime.permissions?.generic
  const permissions = generic ? {
    ...runtime.permissions,
    generic: undefined,
    codex: runtime.permissions?.codex ?? { sandbox: 'inherit' as const, network: 'inherit' as const, additionalDirectories: [] },
  } : runtime.permissions
  if (generic) args.push(...generic.args)
  return {
    ...runtime, adapter: 'codex', args, permissions,
    description: runtime.description === '通用命令适配器；启用前确认可执行路径、参数和输入方式。' ? traexDescription : runtime.description,
  }
}
