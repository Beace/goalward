import { describe, expect, it } from 'vitest'
import { createInitialState } from './domain'
import { validateRuntimePermissions } from './runtime-permissions'
import type { RuntimeConfig } from './types'

const codex = (): RuntimeConfig => ({ ...createInitialState().settings.runtimes[0], permissions: { codex: { sandbox: 'workspace-write', network: 'deny', additionalDirectories: ['/tmp'] } } })
const claude = (): RuntimeConfig => ({ ...createInitialState().settings.runtimes[1], permissions: { claude: { mode: 'dontAsk', additionalDirectories: [], allowedTools: ['Read', 'Bash(git status)'], disallowedTools: ['WebFetch'] } } })

describe('runtime permission validation before saving or starting', () => {
  it('keeps old configurations and fully inherited settings compatible with custom args', () => {
    const runtime = { ...codex(), permissions: undefined, args: ['--sandbox', 'read-only'] }
    expect(validateRuntimePermissions(runtime)).toBeUndefined()
    runtime.permissions = undefined
    expect(validateRuntimePermissions({ ...runtime, permissions: { codex: { sandbox: 'inherit', network: 'inherit', additionalDirectories: [] } } })).toBeUndefined()
  })
  it('accepts valid runtime-specific preferences and harmless model overrides', () => {
    expect(validateRuntimePermissions({ ...codex(), args: ['-c', 'model_reasoning_effort="high"'] })).toBeUndefined()
    expect(validateRuntimePermissions(claude())).toBeUndefined()
    expect(validateRuntimePermissions({ ...codex(), adapter: 'generic', permissions: { generic: { args: ['--permission', 'read-only'] } } })).toBeUndefined()
  })
  it.each([
    ['--sandbox=danger-full-access'], ['-sdanger-full-access'], ['--yolo'], ['--not-so-yolo'], ['--dangerously-bypass-hook-trust'],
    ['-c', 'sandbox_workspace_write={ network_access=true }'], ['--config="permissions".profile="wide"'],
    ['-c=sandbox_mode="danger-full-access"'], ['-csandbox_mode="danger-full-access"'], ['-c', 'approval_policy="never"'], ['--'],
  ])('blocks an extra argument override: %j', (...args) => {
    expect(validateRuntimePermissions({ ...codex(), args })).toContain('覆盖访问权限')
  })
  it.each(['--permission-mode=bypassPermissions', '--allowed-tools', '--settings', '--tools', '--permission-prompts=host', '--'])('blocks a Claude override: %s', arg => {
    expect(validateRuntimePermissions({ ...claude(), args: [arg] })).toContain('覆盖访问权限')
  })
  it('limits network and additional writable directories to the Codex mode which enforces them', () => {
    const runtime = codex()
    runtime.permissions!.codex!.sandbox = 'read-only'
    expect(validateRuntimePermissions(runtime)).toContain('仅适用于')
  })
  it('reports malformed data and invalid directory/rule entries instead of throwing', () => {
    expect(validateRuntimePermissions({ ...codex(), permissions: null as never })).toContain('格式无效')
    expect(validateRuntimePermissions({ ...codex(), permissions: { codex: { sandbox: 'workspace-write', network: 'deny', additionalDirectories: ['~/Desktop'] } } })).toContain('绝对路径')
    expect(validateRuntimePermissions({ ...claude(), permissions: { claude: { ...claude().permissions!.claude!, allowedTools: ['--bypass'] } } })).toContain('工具规则')
    expect(validateRuntimePermissions({ ...claude(), permissions: { claude: { ...claude().permissions!.claude!, disallowedTools: null as never } } })).toContain('工具规则')
  })
})
