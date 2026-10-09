import type { ReactNode, Ref } from 'react'
import { FolderPlus, Shield } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { hasLegacyPermissionOverrides } from '@/lib/runtime-permissions'
import type { ClaudeRuntimePermissions, CodexRuntimePermissions, RuntimeConfig, Settings } from '@/lib/types'

export interface PermissionTextDraft {
  codexDirectories: string
  claudeDirectories: string
  allowedTools: string
  disallowedTools: string
  genericArgs: string
}

const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export function codexPermissionsFor(runtime: RuntimeConfig): CodexRuntimePermissions {
  const value = runtime.permissions?.codex
  return {
    sandbox: value && ['inherit', 'read-only', 'workspace-write', 'danger-full-access'].includes(value.sandbox) ? value.sandbox : (hasLegacyPermissionOverrides(runtime) ? 'inherit' : 'danger-full-access'),
    network: value && ['inherit', 'deny', 'allow'].includes(value.network) ? value.network : 'inherit',
    additionalDirectories: stringArray(value?.additionalDirectories),
  }
}

export function claudePermissionsFor(runtime: RuntimeConfig): ClaudeRuntimePermissions {
  const value = runtime.permissions?.claude
  return {
    mode: value && ['inherit', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(value.mode) ? value.mode : (hasLegacyPermissionOverrides(runtime) ? 'inherit' : 'bypassPermissions'),
    additionalDirectories: stringArray(value?.additionalDirectories),
    allowedTools: stringArray(value?.allowedTools),
    disallowedTools: stringArray(value?.disallowedTools),
  }
}

export function permissionTextFor(runtime: RuntimeConfig): PermissionTextDraft {
  return {
    codexDirectories: stringArray(runtime.permissions?.codex?.additionalDirectories).join('\n'),
    claudeDirectories: stringArray(runtime.permissions?.claude?.additionalDirectories).join('\n'),
    allowedTools: stringArray(runtime.permissions?.claude?.allowedTools).join('\n'),
    disallowedTools: stringArray(runtime.permissions?.claude?.disallowedTools).join('\n'),
    genericArgs: JSON.stringify(runtime.permissions?.generic?.args ?? [], null, 2),
  }
}

export function permissionTextsFor(settings: Settings): Record<string, PermissionTextDraft> {
  return Object.fromEntries(settings.runtimes.map(runtime => [runtime.id, permissionTextFor(runtime)]))
}

export function parsePermissionArgs(text: string): { args?: string[]; error?: string } {
  try {
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return { error: '权限参数必须是 JSON 字符串数组，例如 ["--sandbox", "read-only"]。' }
    }
    return { args: value }
  } catch {
    return { error: '权限参数不是有效的 JSON 数组，请检查引号和逗号。' }
  }
}

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

function PermissionField({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5">
    <Label htmlFor={id} className="pt-2 text-xs leading-5 text-muted-foreground">{label}</Label>
    <div className="min-w-0 space-y-1.5">{children}{hint && <p className="text-[11px] leading-5 text-muted-foreground">{hint}</p>}</div>
  </div>
}

function PermissionSelect({ id, value, options, onChange, disabled }: { id: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger id={id} className="w-full min-w-0"><SelectValue /></SelectTrigger>
    <SelectContent position="popper">{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>
}

interface RuntimePermissionsProps {
  sectionRef?: Ref<HTMLElement>
  runtime: RuntimeConfig
  text: PermissionTextDraft
  error?: string
  onChange: (permissions: RuntimeConfig['permissions']) => void
  onTextChange: (field: keyof PermissionTextDraft, value: string) => void
  onChooseDirectory: (field: 'codexDirectories' | 'claudeDirectories') => void
}

export function RuntimePermissions({ sectionRef, runtime, text, error, onChange, onTextChange, onChooseDirectory }: RuntimePermissionsProps) {
  const codex = codexPermissionsFor(runtime)
  const claude = claudePermissionsFor(runtime)
  const updateCodex = (patch: Partial<typeof codex>) => onChange({ ...runtime.permissions, codex: { ...codex, ...patch } })
  const updateClaude = (patch: Partial<typeof claude>) => onChange({ ...runtime.permissions, claude: { ...claude, ...patch } })
  const directoryField = runtime.adapter === 'codex' ? 'codexDirectories' : 'claudeDirectories'
  const changeDirectories = (value: string) => {
    onTextChange(directoryField, value)
    if (runtime.adapter === 'codex') updateCodex({ additionalDirectories: lines(value) })
    else updateClaude({ additionalDirectories: lines(value) })
  }

  return <section ref={sectionRef} aria-labelledby="runtime-permissions-heading" className="space-y-4">
    <div className="flex min-h-8 items-center justify-between gap-3 border-b border-border pb-2">
      <h3 id="runtime-permissions-heading" className="flex items-center gap-2 text-[13px] font-semibold"><Shield className="size-3.5" />访问权限</h3>
      <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">下次执行生效</Badge>
    </div>
    <p className="text-[11px] leading-5 text-muted-foreground">按 Runtime 配置文件、网络与工具的访问方式。保存后用于下次执行；正在运行的实例与历史记录保留启动时的权限快照。</p>

    {runtime.adapter === 'pi' && <p className="text-xs leading-5 text-muted-foreground">继承 Pi 的工具与项目信任配置。Pi 默认没有逐次工具审批弹窗；需要限制工具时可在高级参数设置 --tools 或 --no-tools，项目信任遵循 Pi 自身设置。</p>}
    {runtime.adapter === 'codex' && <>
      <PermissionField id="permission-codex-sandbox" label="文件访问范围" hint="无需 Git 仓库。此处限制写入范围，其他路径的读取按 Codex 策略执行。切换离开「任务目录可写」会清空本页的额外目录和网络设置，不修改全局配置。">
        <PermissionSelect id="permission-codex-sandbox" value={codex.sandbox} onChange={sandbox => {
          const next = sandbox as typeof codex.sandbox
          updateCodex({ sandbox: next, ...(next !== 'workspace-write' ? { network: 'inherit', additionalDirectories: [] } : {}) })
          if (next !== 'workspace-write') onTextChange('codexDirectories', '')
        }} options={[
          { value: 'inherit', label: '继承 Codex 配置' },
          { value: 'read-only', label: '只读' },
          { value: 'workspace-write', label: '任务目录可写' },
          { value: 'danger-full-access', label: '完整访问（关闭 Codex 沙箱）' },
        ]} />
        {codex.sandbox === 'danger-full-access' && <p className="text-[11px] leading-5 text-destructive">Codex 沙箱将关闭，可访问当前系统账号允许的文件和网络。macOS 自身的权限限制仍然有效。</p>}
        {codex.sandbox === 'read-only' && <p className="text-[11px] leading-5 text-muted-foreground">允许读取文件，禁止在沙箱内写入。网络由只读沙箱策略决定。</p>}
      </PermissionField>
      <PermissionField id="permission-codex-network" label="沙箱命令联网" hint={codex.sandbox === 'workspace-write' ? '只控制沙箱内命令联网，不控制模型 API 或内置网页搜索。继承会沿用 Codex 的对应配置。' : '选择「任务目录可写」后可单独设置命令联网，其余模式由 Codex 对应策略决定。此项不是模型 API 或网页搜索的总开关。'}>
        <PermissionSelect id="permission-codex-network" value={codex.network} disabled={codex.sandbox !== 'workspace-write'} onChange={network => updateCodex({ network: network as typeof codex.network })} options={[
          { value: 'inherit', label: '继承 Runtime 策略' },
          { value: 'deny', label: '禁止网络访问' },
          { value: 'allow', label: '允许网络访问' },
        ]} />
      </PermissionField>
      {codex.sandbox === 'workspace-write' && <PermissionField id="permission-directories" label="额外可写目录" hint="任务目录已包含在内。每行一个绝对路径；此处额外授予写入权限。">
        <Textarea id="permission-directories" className="min-h-20 font-mono text-xs" value={text.codexDirectories} onChange={event => changeDirectories(event.target.value)} placeholder="/absolute/path/to/shared-files" />
        <Button variant="outline" size="sm" onClick={() => onChooseDirectory('codexDirectories')}><FolderPlus className="size-3.5" />添加目录</Button>
      </PermissionField>}
      <p className="text-[11px] leading-5 text-muted-foreground">默认完整访问并自动执行，无需逐项批准。选择只读或任务目录可写后仍执行对应限制，需要额外人工批准的操作会被拒绝。</p>
    </>}

    {runtime.adapter === 'claude' && <>
      <PermissionField id="permission-claude-mode" label="工具审批模式" hint="由 Claude Code 的权限系统执行；工具规则不等同于操作系统沙箱。">
        <PermissionSelect id="permission-claude-mode" value={claude.mode} onChange={mode => updateClaude({ mode: mode as typeof claude.mode })} options={[
          { value: 'inherit', label: '继承 Claude Code 配置' },
          { value: 'manual', label: '默认审批' },
          { value: 'acceptEdits', label: '自动批准文件编辑' },
          { value: 'plan', label: '计划模式（不执行修改）' },
          { value: 'dontAsk', label: '仅运行已批准的工具' },
          { value: 'bypassPermissions', label: '跳过所有工具审批' },
        ]} />
        {claude.mode === 'bypassPermissions' && <p className="text-[11px] leading-5 text-destructive">工具操作将不经过 Claude Code 权限审批，可在当前系统账号允许的范围内执行。</p>}
      </PermissionField>
      <PermissionField id="permission-directories" label="额外工作目录" hint="每行一个绝对路径。任务目录之外允许访问的工作目录，仍受 Claude Code 工具规则约束。">
        <Textarea id="permission-directories" className="min-h-20 font-mono text-xs" value={text.claudeDirectories} onChange={event => changeDirectories(event.target.value)} placeholder="/absolute/path/to/shared-files" />
        <Button variant="outline" size="sm" onClick={() => onChooseDirectory('claudeDirectories')}><FolderPlus className="size-3.5" />添加目录</Button>
      </PermissionField>
      <PermissionField id="permission-allowed-tools" label="自动允许的工具" hint="每行一条 Claude Code 工具规则，例如 Read 或 Bash(git status)。留空不添加规则。">
        <Textarea id="permission-allowed-tools" className="min-h-20 font-mono text-xs" value={text.allowedTools} onChange={event => { onTextChange('allowedTools', event.target.value); updateClaude({ allowedTools: lines(event.target.value) }) }} placeholder={'Read\nBash(git status)'} />
      </PermissionField>
      <PermissionField id="permission-disallowed-tools" label="禁止的工具" hint="每行一条规则，例如 WebFetch 或 Bash(rm *)。禁止规则优先于允许规则。">
        <Textarea id="permission-disallowed-tools" className="min-h-20 font-mono text-xs" value={text.disallowedTools} onChange={event => { onTextChange('disallowedTools', event.target.value); updateClaude({ disallowedTools: lines(event.target.value) }) }} placeholder={'WebFetch\nBash(rm *)'} />
      </PermissionField>
      <p className="text-[11px] leading-5 text-muted-foreground">默认跳过工具审批；可显式选择更严格的模式及禁止工具规则。联网行为由具体工具及 Claude Code 自身配置决定。</p>
    </>}

    {runtime.adapter === 'kimi' && <PermissionField id="permission-kimi-mode" label="工具审批模式" hint="默认自动批准全部工具请求。手动模式中选择本会话批准后，同一会话的后续请求与恢复执行沿用批准结果。">
      <PermissionSelect id="permission-kimi-mode" value={runtime.permissions?.kimi?.mode ?? 'auto'} onChange={mode => onChange({ ...runtime.permissions, kimi: { mode: mode as 'auto' | 'manual' } })} options={[
        { value: 'auto', label: '自动批准全部工具（默认）' },
        { value: 'manual', label: '手动审批' },
      ]} />
    </PermissionField>}

    {runtime.adapter === 'generic' && <PermissionField id="permission-generic-args" label="权限参数 JSON" hint="每个数组元素是一个独立参数，会与高级启动参数一起传给 CLI。参数名称以该 Runtime 文档为准，留空数组表示沿用其配置。">
      <Textarea id="permission-generic-args" className="min-h-24 font-mono text-xs" value={text.genericArgs} aria-invalid={Boolean(error)} aria-describedby={error ? 'runtime-permissions-error' : undefined} onChange={event => {
        onTextChange('genericArgs', event.target.value)
        const parsed = parsePermissionArgs(event.target.value)
        if (parsed.args) onChange({ ...runtime.permissions, generic: { args: parsed.args } })
      }} />
      <p className="text-[11px] leading-5 text-muted-foreground">DeepSeek Harness 默认完整访问。自定义权限参数会覆盖应用默认值；其他通用 CLI 沿用自身协议，请在此填写其自动批准参数。</p>
    </PermissionField>}
    {error && <p id="runtime-permissions-error" role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
  </section>
}
