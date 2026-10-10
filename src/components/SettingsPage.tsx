import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, AlertCircle, ArrowLeft, Check, ChevronDown, Cpu, Database, Download, FolderOpen, HardDrive, Info, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Shield, SlidersHorizontal, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { AppearanceSettings } from './AppearanceSettings'
import { normalizeThemePreference } from '@/lib/theme'
import { RuntimeLogo } from './RuntimeLogo'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { RuntimePermissions, claudePermissionsFor, codexPermissionsFor, parsePermissionArgs, permissionTextFor, permissionTextsFor, type PermissionTextDraft } from './RuntimePermissions'
import { ScrollArea } from '@/components/ui/scroll-area'
import { chooseDirectory, chooseFile, isDesktop, probeRuntime, storageInfo } from '@/lib/bridge'
import { validateRuntimePermissions } from '@/lib/runtime-permissions'
import { getModelReasoningOptions, reasoningLabel, validateModelReasoning } from '@/lib/reasoning'
import type { Adapter, LocalDiscoveryReport, ModelConfig, ProbeResult, ProviderConfig, ReasoningEffort, RuntimeConfig, Settings, StorageInfo } from '@/lib/types'

export interface SettingsPageProps {
  settings: Settings
  onSave: (settings: Settings) => Promise<void>
  onBack: () => void
  onExport: () => void
  activeCount: number
  initialCategory?: 'runtimes' | 'models'
  initialRuntimeId?: string
  setupHint?: boolean
  onDiscover?: () => void
  discoveryReport?: LocalDiscoveryReport
}

type Category = 'appearance' | 'runtimes' | 'models' | 'execution' | 'storage'
type Notice = { text: string; error?: boolean }
type RuntimeProbe = { executable: string; busy: boolean; result?: ProbeResult; error?: string }
const categories = [
  { id: 'runtimes' as const, label: '运行时', icon: Cpu },
  { id: 'models' as const, label: '模型与供应商', icon: Database },
  { id: 'appearance' as const, label: '外观', icon: Type },
  { id: 'execution' as const, label: '执行默认值', icon: SlidersHorizontal },
  { id: 'storage' as const, label: '记录与存储', icon: HardDrive },
]
const adapters: { value: Adapter; label: string }[] = [
  { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'kimi', label: 'Kimi Code CLI · ACP' }, { value: 'pi', label: 'Pi · JSON' }, { value: 'generic', label: '通用 CLI / Harness' },
]
const copy = <T,>(value: T): T => structuredClone(value)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const argsFor = (settings: Settings) => Object.fromEntries(settings.runtimes.map(runtime => [runtime.id, JSON.stringify(runtime.args, null, 2)]))
function parseArgs(text: string): { args: string[]; error?: string } {
  try {
    const args: unknown = JSON.parse(text)
    if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) return { args: [], error: '请输入 JSON 字符串数组，例如 ["--verbose"]。' }
    return { args }
  } catch { return { args: [], error: '启动参数不是有效的 JSON 数组。请检查引号和逗号。' } }
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB'
}
function Field({ id, label, children, hint }: { id?: string; label: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5">
    <Label htmlFor={id} className="pt-2 text-xs leading-5 text-muted-foreground">{label}</Label>
    <div className="min-w-0 space-y-1.5">{children}{hint && <p className="text-[11px] leading-5 text-muted-foreground">{hint}</p>}</div>
  </div>
}
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="space-y-4"><div className="flex min-h-8 items-center justify-between gap-3 border-b border-border pb-2"><h3 className="text-[13px] font-semibold">{title}</h3>{action}</div>{children}</section>
}
function Picker({ id, label, value, options, onChange, disabled }: { id?: string; label: string; value: string; options: { value: string; label: string; disabled?: boolean; runtime?: RuntimeConfig }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger id={id} aria-label={label} className="w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent position="popper">{options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled} textValue={option.label}>{option.runtime ? <span className="inline-flex items-center gap-2"><RuntimeLogo runtime={option.runtime} size={16} /><span>{option.label}</span></span> : option.label}</SelectItem>)}</SelectContent></Select>
}
function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 py-10 text-center"><Database className="size-6 text-muted-foreground" /><div><p className="text-sm font-medium">{title}</p><p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{description}</p></div>{action}</div>
}

export function SettingsPage({ settings, onSave, onBack, onExport, activeCount, initialCategory = 'runtimes', initialRuntimeId, setupHint, onDiscover, discoveryReport }: SettingsPageProps) {
  const [draft, setDraft] = useState(() => copy(settings))
  const [baseline, setBaseline] = useState(() => copy(settings))
  const [argTexts, setArgTexts] = useState(() => argsFor(settings))
  const [permissionTexts, setPermissionTexts] = useState(() => permissionTextsFor(settings))
  const [category, setCategory] = useState<Category>(initialCategory)
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(initialRuntimeId ?? settings.runtimes[0]?.id ?? '')
  const [runtimeSearch, setRuntimeSearch] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [modelFilter, setModelFilter] = useState('__all__')
  const [modelTab, setModelTab] = useState('catalog')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [discardTarget, setDiscardTarget] = useState<'back' | 'discover' | null>(null)
  const [newRuntime, setNewRuntime] = useState<RuntimeConfig | null>(null)
  const [modelEditor, setModelEditor] = useState<ModelConfig | null>(null)
  const [providerEditor, setProviderEditor] = useState<ProviderConfig | null>(null)
  const [editorError, setEditorError] = useState('')
  const [probes, setProbes] = useState<Record<string, RuntimeProbe>>({})
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState('')
  const permissionSection = useRef<HTMLElement>(null)
  const probeRequests = useRef<Record<string, number>>({})
  const storageRequest = useRef(0)
  const incoming = useRef(JSON.stringify(settings))
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const live = useRef(true)
  const argErrors = useMemo(() => draft.runtimes.flatMap(runtime => {
    const parsed = parseArgs(argTexts[runtime.id] ?? '[]')
    return parsed.error ? [{ id: runtime.id, name: runtime.name, error: parsed.error }] : []
  }), [argTexts, draft.runtimes])
  const permissionErrors = useMemo(() => draft.runtimes.flatMap(runtime => {
    const rawError = runtime.adapter === 'generic' ? parsePermissionArgs(permissionTexts[runtime.id]?.genericArgs ?? '[]').error : undefined
    const error = rawError ?? validateRuntimePermissions(runtime)
    return error ? [{ id: runtime.id, name: runtime.name, error }] : []
  }), [permissionTexts, draft.runtimes])
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || argErrors.length > 0 || permissionErrors.length > 0
  dirtyRef.current = dirty
  savingRef.current = saving
  const runtime = draft.runtimes.find(item => item.id === selectedRuntimeId) ?? draft.runtimes[0]
  const currentProbe = runtime && probes[runtime.id]?.executable === runtime.executable ? probes[runtime.id] : undefined
  const previousDiscovery = runtime && discoveryReport?.runtimes.find(item => item.id === runtime.id && item.adapter === runtime.adapter && (item.executable === runtime.executable || Boolean(item.probe.path && item.probe.path === runtime.executable)))
  const historicalProbe = !currentProbe && previousDiscovery
  const displayedProbe: RuntimeProbe | undefined = currentProbe ?? (previousDiscovery ? { executable: previousDiscovery.executable, busy: false, result: previousDiscovery.probe } : undefined)
  const scannedAt = discoveryReport ? new Date(discoveryReport.scannedAt) : undefined
  const scanTime = scannedAt && !Number.isNaN(scannedAt.valueOf()) ? scannedAt.toLocaleString('zh-CN', { hour12: false }) : '时间未知'
  const compatibleModels = runtime ? draft.models.filter(model => model.enabled && model.runtimeIds.includes(runtime.id)) : []
  const currentModel = runtime ? compatibleModels.find(model => model.modelId === runtime.defaultModel) : undefined
  const enabledRuntimes = draft.runtimes.filter(item => item.enabled)
  const visibleModels = draft.models.filter(model => (model.name + ' ' + model.modelId).toLowerCase().includes(modelSearch.toLowerCase()) && (modelFilter === '__all__' || model.runtimeIds.includes(modelFilter)))

  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const serialized = JSON.stringify(settings)
    if (serialized === incoming.current) return
    incoming.current = serialized
    if (!dirtyRef.current && !savingRef.current) { setDraft(copy(settings)); setBaseline(copy(settings)); setArgTexts(argsFor(settings)); setPermissionTexts(permissionTextsFor(settings)) }
  }, [settings])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => { if (category === 'storage') void refreshStorage() }, [category])

  function updateRuntime(id: string, patch: Partial<RuntimeConfig>) {
    setDraft(current => ({ ...current, runtimes: current.runtimes.map(item => item.id === id ? { ...item, ...patch } : item) }))
    setNotice(null)
  }
  function updatePermissionText(id: string, field: keyof PermissionTextDraft, value: string) {
    setPermissionTexts(current => ({ ...current, [id]: { ...current[id], [field]: value } }))
    setNotice(null)
  }
  async function pickPermissionDirectory(id: string, field: 'codexDirectories' | 'claudeDirectories') {
    try {
      const path = await chooseDirectory()
      if (!path || !live.current) return
      setPermissionTexts(current => {
        const previous = current[id]
        if (!previous) return current
        const paths = (previous[field] || '').split('\n').map(value => value.trim()).filter(Boolean)
        return { ...current, [id]: { ...previous, [field]: [...new Set([...paths, path])].join('\n') } }
      })
      setDraft(current => ({ ...current, runtimes: current.runtimes.map(item => {
        if (item.id !== id) return item
        if (field === 'codexDirectories') {
          const codex = codexPermissionsFor(item)
          return { ...item, permissions: { ...item.permissions, codex: { ...codex, additionalDirectories: [...new Set([...codex.additionalDirectories, path])] } } }
        }
        const claude = claudePermissionsFor(item)
        return { ...item, permissions: { ...item.permissions, claude: { ...claude, additionalDirectories: [...new Set([...claude.additionalDirectories, path])] } } }
      }) }))
      setNotice(null)
    } catch (error) { if (live.current) setNotice({ text: errorText(error), error: true }) }
  }
  async function pickExecutable(id: string) {
    try {
      const path = await chooseFile()
      if (path && live.current) updateRuntime(id, { executable: path })
    } catch (error) { if (live.current) setNotice({ text: errorText(error), error: true }) }
  }
  async function detectRuntime(item: RuntimeConfig) {
    if (!item.executable.trim()) { setNotice({ text: '请先填写可执行文件路径或命令名称。', error: true }); return }
    const request = (probeRequests.current[item.id] ?? 0) + 1
    probeRequests.current[item.id] = request
    setProbes(current => ({ ...current, [item.id]: { executable: item.executable, busy: true } }))
    try {
      const result = await probeRuntime(item.executable)
      if (live.current && probeRequests.current[item.id] === request) setProbes(current => ({ ...current, [item.id]: { executable: item.executable, busy: false, result } }))
    } catch (error) {
      if (live.current && probeRequests.current[item.id] === request) setProbes(current => ({ ...current, [item.id]: { executable: item.executable, busy: false, error: errorText(error) } }))
    }
  }
  async function refreshStorage() {
    const request = ++storageRequest.current
    setStorageLoading(true); setStorageError('')
    try { const result = await storageInfo(); if (live.current && request === storageRequest.current) setStorage(result) }
    catch (error) { if (live.current && request === storageRequest.current) setStorageError(errorText(error)) }
    finally { if (live.current && request === storageRequest.current) setStorageLoading(false) }
  }
  async function pickDirectory() {
    try { const path = await chooseDirectory(); if (path && live.current) { setDraft(current => ({ ...current, defaultDirectory: path })); setNotice(null) } }
    catch (error) { if (live.current) setNotice({ text: errorText(error), error: true }) }
  }
  function beginRuntime() {
    setEditorError('')
    setNewRuntime({ id: crypto.randomUUID(), name: '', executable: '', adapter: 'generic', enabled: false, args: [], defaultModel: '', description: '' })
  }
  function addRuntime() {
    if (!newRuntime) return
    if (!newRuntime.name.trim()) { setEditorError('请填写运行时名称。'); return }
    setDraft(current => ({ ...current, runtimes: [...current.runtimes, newRuntime] }))
    setArgTexts(current => ({ ...current, [newRuntime.id]: '[]' }))
    setPermissionTexts(current => ({ ...current, [newRuntime.id]: permissionTextFor(newRuntime) }))
    setSelectedRuntimeId(newRuntime.id); setRuntimeSearch(''); setCategory('runtimes'); setNewRuntime(null)
    setNotice({ text: '运行时已加入待保存配置。配置路径并启用后，可用于新建成员。' })
  }
  function beginModel(model?: ModelConfig) {
    setEditorError('')
    setModelEditor(model ? copy(model) : { id: crypto.randomUUID(), name: '', modelId: '', providerId: '', runtimeIds: [], enabled: true })
  }
  function updateModel(model: ModelConfig) {
    const old = draft.models.find(item => item.id === model.id)
    const affected = old ? draft.runtimes.filter(item => item.defaultModel === old.modelId && old.runtimeIds.includes(item.id)) : []
    setDraft(current => ({ ...current,
      models: old ? current.models.map(item => item.id === model.id ? model : item) : [...current.models, model],
      runtimes: current.runtimes.map(item => affected.some(affectedRuntime => affectedRuntime.id === item.id) ? { ...item, defaultModel: model.enabled && model.runtimeIds.includes(item.id) ? model.modelId : '' } : item),
    }))
    setNotice(affected.length ? { text: '模型配置和相关运行时的默认模型已同步到草稿；不兼容或停用的默认项改为跟随运行时默认。运行中实例不受影响。' } : null)
  }
  function applyModel() {
    if (!modelEditor) return
    if (!modelEditor.name.trim() || !modelEditor.modelId.trim()) { setEditorError('请填写显示名称和真实 Model ID。'); return }
    if (modelEditor.enabled && modelEditor.runtimeIds.length === 0) { setEditorError('请至少选择一个相容的 Runtime，或关闭启用状态以保存待绑定条目。'); return }
    if (draft.models.some(item => item.id !== modelEditor.id && item.modelId === modelEditor.modelId && item.providerId === modelEditor.providerId)) { setEditorError('该来源中已存在相同 Model ID，请编辑已有条目。'); return }
    const reasoningError = validateModelReasoning(modelEditor, draft.runtimes)
    if (reasoningError) { setEditorError(reasoningError); return }
    updateModel(modelEditor); setModelEditor(null)
  }
  function beginProvider(provider?: ProviderConfig) {
    setEditorError(''); setProviderEditor(provider ? copy(provider) : { id: crypto.randomUUID(), name: '', baseUrl: '', credentialEnv: '' })
  }
  function applyProvider() {
    if (!providerEditor) return
    if (!providerEditor.name.trim()) { setEditorError('请填写连接名称。'); return }
    if (providerEditor.credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(providerEditor.credentialEnv)) { setEditorError('只填写环境变量名称，例如 OPENAI_API_KEY，不包含等号或密钥值。'); return }
    if (providerEditor.baseUrl) {
      try { const url = new URL(providerEditor.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid') }
      catch { setEditorError('Base URL 需为不含账号或密码的 HTTP(S) 地址。'); return }
    }
    setDraft(current => ({ ...current, providers: current.providers.some(item => item.id === providerEditor.id) ? current.providers.map(item => item.id === providerEditor.id ? providerEditor : item) : [...current.providers, providerEditor] }))
    setProviderEditor(null); setNotice({ text: '已更新供应商登记信息，等待保存。此配置不替代 Runtime 自身的认证。' })
  }
  function validate() {
    if (argErrors.length) { setCategory('runtimes'); setSelectedRuntimeId(argErrors[0].id); return argErrors[0].name + '：' + argErrors[0].error }
    if (permissionErrors.length) { setCategory('runtimes'); setSelectedRuntimeId(permissionErrors[0].id); return permissionErrors[0].name + '：' + permissionErrors[0].error }
    const invalidRuntime = draft.runtimes.find(item => !item.name.trim() || (item.enabled && !item.executable.trim()))
    if (invalidRuntime) { setCategory('runtimes'); setSelectedRuntimeId(invalidRuntime.id); return '请填写运行时名称；启用的运行时还需要可执行文件路径。' }
    const invalidModel = draft.models.find(item => validateModelReasoning(item, draft.runtimes))
    if (invalidModel) { setCategory('models'); setModelTab('catalog'); return invalidModel.name + '：' + validateModelReasoning(invalidModel, draft.runtimes) }
    if (!Number.isInteger(draft.maxParallel) || draft.maxParallel < 1 || draft.maxParallel > 8) { setCategory('execution'); return '同时执行的成员数量需为 1 到 8 的整数。' }
    if (draft.defaultRuntime && !enabledRuntimes.some(item => item.id === draft.defaultRuntime)) { setCategory('execution'); return '默认 Runtime 已停用，请选择已启用的运行时，或清空默认选项。' }
    return null
  }
  async function saveChanges() {
    if (saving) return
    const invalid = validate()
    if (invalid) { setNotice({ text: invalid, error: true }); return }
    const snapshot = copy(draft)
    setSaving(true); setNotice(null)
    try {
      await onSave(snapshot)
      if (live.current) { setBaseline(snapshot); setNotice({ text: '配置已保存。外观立即生效；Runtime 配置用于下次执行，默认值用于新建成员。' }) }
    } catch (error) { if (live.current) setNotice({ text: '保存失败：' + errorText(error) + '。编辑内容已保留。', error: true }) }
    finally { if (live.current) setSaving(false) }
  }
  function reset() { setDraft(copy(baseline)); setArgTexts(argsFor(baseline)); setPermissionTexts(permissionTextsFor(baseline)); setNotice({ text: '已还原到上次保存的配置。' }) }
  function leaveSettings(target: 'back' | 'discover') {
    if (saving) return
    if (dirty) { setDiscardTarget(target); return }
    if (target === 'discover') onDiscover?.()
    else onBack()
  }
  function discardAndLeave() {
    const target = discardTarget
    setDiscardTarget(null)
    setDraft(copy(baseline)); setArgTexts(argsFor(baseline)); setPermissionTexts(permissionTextsFor(baseline)); setNotice(null)
    if (target === 'discover') onDiscover?.()
    else if (target === 'back') onBack()
  }

  return <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-sidebar px-4">
      <div className="flex items-center gap-3"><span className="text-[13px] font-semibold">设置</span><span className="text-[11px] text-muted-foreground">工作空间的运行环境与默认配置</span></div>
      <div className="flex items-center gap-2">{onDiscover && <Button variant="outline" size="sm" disabled={saving} onClick={() => leaveSettings('discover')}><Search className="size-3.5" />自动检测本机</Button>}<Button variant="ghost" size="sm" disabled={saving} onClick={() => leaveSettings('back')}><ArrowLeft className="size-3.5" />返回工作台</Button></div>
    </header>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <nav aria-label="设置分类" className="flex w-[200px] shrink-0 flex-col border-r border-border bg-sidebar p-2">
        <div className="px-2 pb-2 pt-3 text-[11px] text-muted-foreground">全局设置</div>
        <div className="space-y-1">{categories.map(item => <Button key={item.id} variant="ghost" className={'w-full justify-start gap-2 px-2 ' + (category === item.id ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground')} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}><item.icon className="size-4" />{item.label}</Button>)}</div>
        <div className="mt-auto space-y-2 px-2 py-4 text-[11px] leading-5 text-muted-foreground"><Separator /><p className="flex items-center gap-1.5"><Activity className="size-3" />{activeCount} 个实例执行中</p><p>设置更新不重启当前实例。</p></div>
      </nav>
      {category === 'runtimes' && <aside aria-label="运行时列表" className="flex w-[264px] shrink-0 flex-col border-r border-border">
        <div className="flex gap-2 border-b border-border p-3"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input aria-label="搜索运行时" placeholder="搜索运行时" value={runtimeSearch} onChange={event => setRuntimeSearch(event.target.value)} className="pl-7" /></div><Button variant="outline" size="icon-sm" aria-label="添加 Runtime" title="添加 Runtime" onClick={beginRuntime}><Plus className="size-4" /></Button></div>
        <ScrollArea className="min-h-0 flex-1"><div className="space-y-1 p-2">{draft.runtimes.filter(item => item.name.toLowerCase().includes(runtimeSearch.toLowerCase())).map(item => <Button key={item.id} variant="ghost" aria-pressed={runtime?.id === item.id} className={'h-auto min-h-14 w-full justify-between border px-2 py-2 text-left ' + (runtime?.id === item.id ? 'border-border bg-card text-accent-foreground' : 'border-transparent text-muted-foreground')} onClick={() => setSelectedRuntimeId(item.id)}><span className="flex min-w-0 items-start gap-2"><RuntimeLogo runtime={item} size={16} className="mt-0.5" /><span className="min-w-0"><span className="block truncate text-xs font-medium">{item.name || '未命名运行时'}</span><span className="mt-1 block text-[11px] font-normal text-muted-foreground">{item.enabled ? item.executable ? '已启用 · 路径已配置' : '已启用 · 待配置路径' : '已停用'}</span></span></span><span className={'ml-2 size-1.5 shrink-0 rounded-full ' + (item.enabled ? 'bg-accent-foreground' : 'bg-border')} /></Button>)}{!draft.runtimes.some(item => item.name.toLowerCase().includes(runtimeSearch.toLowerCase())) && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{runtimeSearch ? '没有匹配的运行时' : '尚未添加运行时'}</p>}</div></ScrollArea>
        <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">{draft.runtimes.length} 个注册项 · {enabledRuntimes.length} 个已启用</div>
      </aside>}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1"><div className={'p-6 pb-8 ' + (category === 'models' ? 'max-w-[1120px]' : 'max-w-[812px]')}>
          {setupHint && (category === 'runtimes' || category === 'models') && <section aria-label="首次配置指引" className="mb-6 space-y-2 rounded-md border border-border bg-card/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-xs font-medium"><Info className="size-3.5 text-accent-foreground" />完成本机运行环境配置</h2><Button variant="link" size="sm" className="h-auto p-0" onClick={() => { setCategory(category === 'models' ? 'runtimes' : 'models'); setModelTab('catalog'); setModelFilter(runtime?.id ?? '__all__') }}>{category === 'models' ? '配置运行时' : '登记模型'}</Button></div>
            <ol className="list-inside list-decimal space-y-1 text-[11px] leading-5 text-muted-foreground"><li>选择已安装的可执行文件，或输入命令名称，再点击「检测可执行文件」。</li><li>在 Runtime 自身完成登录；可跟随其默认模型，也可登记实际 Model ID 并绑定 Runtime。</li><li>启用运行时并保存更改，即可在工作台创建任务。通用 CLI 还需填写非交互启动参数。</li></ol>
          </section>}
          {category === 'runtimes' && (runtime ? <div className="space-y-7">
            <div className="flex items-start justify-between gap-4"><div><h1 className="flex items-center gap-2 text-xl font-semibold"><RuntimeLogo runtime={runtime} size={20} />{runtime.name || '未命名运行时'}</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">管理 Agent 执行环境，供任务成员选择。</p></div><div className="flex flex-wrap items-center justify-end gap-2 pt-1"><Button variant="outline" size="sm" onClick={() => permissionSection.current?.scrollIntoView({ block: 'start', behavior: 'auto' })}><Shield className="size-3.5" />访问权限</Button><Label htmlFor="runtime-enabled" className="text-xs">启用注册项</Label><Switch id="runtime-enabled" checked={runtime.enabled} onCheckedChange={enabled => { updateRuntime(runtime.id, { enabled }); if (!enabled) setNotice({ text: '已停用此注册项的草稿；保存后仅影响新成员，当前 ' + activeCount + ' 个执行实例不受影响。' }) }} /></div></div>
            <Section title="接入配置">
              <Field id="runtime-name" label="名称"><Input id="runtime-name" value={runtime.name} onChange={event => updateRuntime(runtime.id, { name: event.target.value })} /></Field>
              <Field id="runtime-adapter" label="运行时适配器" hint="适配器决定调用与输出解析方式，不代表已通过认证或模型访问检查。"><Picker id="runtime-adapter" label="运行时适配器" value={runtime.adapter} options={adapters} onChange={value => updateRuntime(runtime.id, { adapter: value as Adapter })} /></Field>
              {runtime.adapter === 'pi' && <p className="text-xs leading-5 text-muted-foreground">通过 Pi JSON 事件流执行，支持回答、思考、工具 Trace 与会话续接。模型使用 provider/model 格式，留空跟随 Pi 默认；思考设置继承 Pi。登录、项目信任和工具权限由 Pi 自身配置负责。</p>}
              {runtime.adapter === 'kimi' && <p className="text-xs leading-5 text-muted-foreground">Kimi Code CLI 通过 ACP 执行；默认自动批准工具权限，可在下方切换为手动审批。模型填写 Kimi config.toml 中的别名，留空继承默认模型。自动检测并导入后，可按模型选择支持的思考强度，也可继承 Runtime 配置。旧 Python kimi-cli 不支持此适配器。</p>}
              <Field id="runtime-executable" label="可执行文件" hint="填写命令名称或本机文件路径。检测仅检查可执行文件与版本。"><div className="flex gap-2"><Input id="runtime-executable" className="min-w-0 font-mono" placeholder="例如 codex 或 /usr/local/bin/codex" value={runtime.executable} onChange={event => updateRuntime(runtime.id, { executable: event.target.value })} /><Button variant="outline" size="sm" onClick={() => void pickExecutable(runtime.id)} aria-label="选择运行时可执行文件"><FolderOpen className="size-3.5" />选择</Button></div></Field>
              <Field label="安装 / 版本"><div className="flex min-h-8 flex-wrap items-center gap-3"><span className={'flex items-center gap-1.5 text-xs ' + (displayedProbe?.error || displayedProbe?.result?.error ? 'text-destructive' : 'text-muted-foreground')}>{displayedProbe?.busy ? <><RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" />检测中…</> : displayedProbe?.result?.found ? <><Check className="size-3.5" />{historicalProbe ? '上次已找到可执行文件' : '已找到可执行文件'}</> : displayedProbe?.result || displayedProbe?.error ? <><AlertCircle className="size-3.5" />{historicalProbe ? '上次检测未通过' : '检测未通过'}</> : <><Info className="size-3.5" />尚未检测</>}</span><Button variant="outline" size="sm" disabled={currentProbe?.busy || !runtime.executable.trim()} onClick={() => void detectRuntime(runtime)}>检测可执行文件</Button></div>{historicalProbe && <p className="text-[11px] leading-5 text-muted-foreground">上次检测：<time dateTime={discoveryReport?.scannedAt}>{scanTime}</time> · 可重新检测当前状态</p>}{displayedProbe?.result?.found && <p className="break-all font-mono text-[11px] leading-5 text-muted-foreground">{displayedProbe.result.path}<br />{displayedProbe.result.version || '未获得版本信息'}</p>}{(displayedProbe?.error || displayedProbe?.result?.error) && <p role="alert" className="break-words text-xs text-destructive">{displayedProbe.error || displayedProbe.result?.error}</p>}</Field>
              <Field label="认证来源"><div className="flex min-h-8 items-center gap-2 text-xs"><Shield className="size-3.5 text-muted-foreground" />使用 Runtime 自身登录状态<Badge variant="outline" className="ml-auto text-[10px] text-muted-foreground">未检查认证</Badge></div><p className="text-[11px] leading-5 text-muted-foreground">登录由各 Runtime 自身管理。版本检测不验证账号、API 凭据或模型权限。</p></Field>
            </Section>
            <RuntimePermissions sectionRef={permissionSection} runtime={runtime} text={permissionTexts[runtime.id] ?? permissionTextFor(runtime)} error={permissionErrors.find(item => item.id === runtime.id)?.error} onChange={permissions => updateRuntime(runtime.id, { permissions })} onTextChange={(field, value) => updatePermissionText(runtime.id, field, value)} onChooseDirectory={field => void pickPermissionDirectory(runtime.id, field)} />
            <Section title="默认模型与兼容配置" action={<Button variant="link" size="sm" onClick={() => { setCategory('models'); setModelTab('catalog'); setModelFilter(runtime.id) }}>管理模型</Button>}>
              <Field id="runtime-model" label="新成员默认模型" hint="空默认由运行时自行决定。目录中的兼容关系由你配置，不等于已验证模型可用性。"><Picker id="runtime-model" label="新成员默认模型" value={currentModel?.id ?? (runtime.defaultModel ? '__existing__' : '__default__')} onChange={value => updateRuntime(runtime.id, { defaultModel: value === '__default__' ? '' : compatibleModels.find(model => model.id === value)?.modelId ?? runtime.defaultModel })} options={[{ value: '__default__', label: '跟随运行时默认' }, ...(runtime.defaultModel && !currentModel ? [{ value: '__existing__', label: runtime.defaultModel + '（当前配置，目录未匹配）' }] : []), ...compatibleModels.map(model => ({ value: model.id, label: model.name + ' · ' + model.modelId }))]} /></Field>
              <div className="overflow-hidden rounded-md border border-border"><Table><TableHeader><TableRow><TableHead>模型</TableHead><TableHead>Model ID</TableHead><TableHead>思考强度</TableHead><TableHead>来源</TableHead></TableRow></TableHeader><TableBody>{compatibleModels.map(model => <TableRow key={model.id}><TableCell className="text-xs">{model.name}</TableCell><TableCell className="font-mono text-xs">{model.modelId}</TableCell><TableCell className="text-xs text-muted-foreground">{reasoningLabel(model.reasoningEffort ?? 'inherit')}</TableCell><TableCell className="text-xs text-muted-foreground">{draft.providers.find(provider => provider.id === model.providerId)?.name ?? 'Runtime 自身配置'}</TableCell></TableRow>)}{!compatibleModels.length && <TableRow><TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">尚未配置兼容模型，可继续跟随运行时默认。</TableCell></TableRow>}</TableBody></Table></div>
            </Section>
            <Collapsible className="rounded-md border border-border bg-card/50"><CollapsibleTrigger asChild><Button variant="ghost" className="group h-10 w-full justify-start px-4"><CollapsibleIndicator size={14} />高级启动配置</Button></CollapsibleTrigger><CollapsibleContent><div className="space-y-4 border-t border-border p-4"><Field id="runtime-args" label="启动参数 JSON" hint="每个数组元素对应一个独立参数；无需 shell 转义，不要把密钥写入参数。"><Textarea id="runtime-args" className="min-h-24 font-mono text-xs" aria-invalid={Boolean(argErrors.find(error => error.id === runtime.id))} aria-describedby={argErrors.some(error => error.id === runtime.id) ? 'runtime-args-error' : undefined} value={argTexts[runtime.id] ?? '[]'} onChange={event => { const value = event.target.value; setArgTexts(current => ({ ...current, [runtime.id]: value })); const parsed = parseArgs(value); if (!parsed.error) updateRuntime(runtime.id, { args: parsed.args }); else setNotice(null) }} />{argErrors.find(error => error.id === runtime.id) && <p id="runtime-args-error" role="alert" className="text-xs text-destructive">{argErrors.find(error => error.id === runtime.id)?.error}</p>}</Field><Field id="runtime-description" label="备注"><Textarea id="runtime-description" className="min-h-16 text-xs" value={runtime.description} placeholder="该运行时的用途或环境说明" onChange={event => updateRuntime(runtime.id, { description: event.target.value })} /></Field></div></CollapsibleContent></Collapsible>
          </div> : <EmptyState title="添加第一个运行时" description="注册本机的 CLI 或 Harness，为任务选择执行环境。" action={<Button size="sm" onClick={beginRuntime}><Plus className="size-3.5" />添加 Runtime</Button>} />)}

          {category === 'models' && <div className="space-y-6"><div><h1 className="text-xl font-semibold">模型与供应商</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">维护模型目录与相容运行时。供应商连接只登记元信息，认证仍由 Runtime 管理。</p></div><Tabs value={modelTab} onValueChange={setModelTab}><TabsList className="mb-5"><TabsTrigger value="catalog">模型目录 <span className="ml-1.5 opacity-60">{draft.models.length}</span></TabsTrigger><TabsTrigger value="providers">供应商连接 <span className="ml-1.5 opacity-60">{draft.providers.length}</span></TabsTrigger></TabsList>
            <TabsContent value="catalog" className="space-y-4"><div className="flex flex-wrap items-center gap-2"><div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input className="pl-7" aria-label="搜索模型名称或 Model ID" placeholder="搜索模型名称或 Model ID" value={modelSearch} onChange={event => setModelSearch(event.target.value)} /></div><div className="w-48"><Picker label="按 Runtime 筛选模型" value={modelFilter} onChange={setModelFilter} options={[{ value: '__all__', label: '全部 Runtime' }, ...draft.runtimes.map(item => ({ value: item.id, label: item.name, runtime: item }))]} /></div><Button size="sm" onClick={() => beginModel()}><Plus className="size-3.5" />添加模型</Button></div>
              {visibleModels.length ? <div className="rounded-md border border-border"><Table><TableHeader><TableRow><TableHead>显示名称 / Model ID</TableHead><TableHead>来源连接</TableHead><TableHead>兼容 Runtime</TableHead><TableHead>启用</TableHead><TableHead className="w-12"><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>{visibleModels.map(model => <TableRow key={model.id}><TableCell><p className="text-xs font-medium">{model.name}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{model.modelId}</p><p className="mt-1 text-[10px] text-muted-foreground">思考：{reasoningLabel(model.reasoningEffort ?? 'inherit')}</p></TableCell><TableCell className="text-xs text-muted-foreground">{draft.providers.find(item => item.id === model.providerId)?.name ?? (model.providerId ? '连接未找到' : 'Runtime 自身配置')}</TableCell><TableCell><div className="flex max-w-64 flex-wrap gap-1">{model.runtimeIds.map(id => <Badge key={id} variant="outline" className="gap-1 text-[10px] font-normal"><RuntimeLogo runtime={draft.runtimes.find(item => item.id === id)} size={12} />{draft.runtimes.find(item => item.id === id)?.name ?? '未找到 Runtime'}</Badge>)}{!model.runtimeIds.length && <span className="text-xs text-muted-foreground">待绑定</span>}</div></TableCell><TableCell><Switch aria-label={'启用模型 ' + model.name} checked={model.enabled} onCheckedChange={enabled => { if (enabled && !model.runtimeIds.length) { beginModel(model); setEditorError('启用前请选择至少一个相容的 Runtime。'); return } updateModel({ ...model, enabled }) }} /></TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={'编辑模型 ' + model.name} onClick={() => beginModel(model)}><Pencil className="size-3.5" /></Button></TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title={draft.models.length ? '没有匹配的模型' : '模型目录还是空的'} description="添加你要使用的 Model ID，并指定兼容的 Runtime。未添加模型时仍可使用 Runtime 默认模型。" />}
              <p className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />启用与兼容关系是配置值，应用尚未执行模型访问验证。停用模型会同时清除相关 Runtime 的模型默认值，当前执行不受影响。</p>
            </TabsContent>
            <TabsContent value="providers" className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-[13px] font-medium">已登记连接</h2><Button size="sm" onClick={() => beginProvider()}><Plus className="size-3.5" />添加连接</Button></div>{draft.providers.length ? <div className="rounded-md border border-border"><Table><TableHeader><TableRow><TableHead>连接名称</TableHead><TableHead>Base URL</TableHead><TableHead>凭据环境变量</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>{draft.providers.map(provider => <TableRow key={provider.id}><TableCell><p className="text-xs font-medium">{provider.name}</p><p className="mt-1 text-[11px] text-muted-foreground">仅登记 · 未检测连接</p></TableCell><TableCell className="max-w-72 break-all font-mono text-[11px] text-muted-foreground">{provider.baseUrl || '由 Runtime 管理'}</TableCell><TableCell className="font-mono text-[11px]">{provider.credentialEnv || '未指定'}</TableCell><TableCell><Button variant="ghost" size="icon-sm" aria-label={'编辑供应商连接 ' + provider.name} onClick={() => beginProvider(provider)}><Pencil className="size-3.5" /></Button></TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title="尚未登记供应商连接" description="使用 Runtime 自身登录时无需添加。可按需登记连接地址和凭据环境变量名称，以便管理模型来源。" />}
              <div className="flex gap-3 rounded-md border border-border bg-card/40 p-4"><Shield className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="space-y-1 text-xs leading-5"><p>只保存环境变量名称，不填写密钥值。</p><p className="text-muted-foreground">当前这些登记信息不会注入进程或覆盖 Runtime 登录。请在运行时自己的配置中完成认证；此页面不读取凭据值。</p></div></div>
            </TabsContent>
          </Tabs></div>}

          {category === 'appearance' && <AppearanceSettings value={draft.fontFamily} themeValue={normalizeThemePreference(draft.theme)} disabled={saving} onChange={fontFamily => { setDraft(current => ({ ...current, fontFamily })); setNotice(null) }} onThemeChange={theme => { setDraft(current => ({ ...current, theme })); setNotice(null) }} />}
          {category === 'execution' && <div className="space-y-7"><div><h1 className="text-xl font-semibold">执行默认值</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">新建任务和成员的起点；任务中的独立配置与历史 Run 保持原样。</p></div><Section title="新任务默认配置"><Field id="default-mode" label="执行模式"><Picker id="default-mode" label="新任务默认执行模式" value={draft.defaultMode} onChange={value => { setDraft(current => ({ ...current, defaultMode: value as 'solo' | 'team' })); setNotice(null) }} options={[{ value: 'solo', label: '单 Agent' }, { value: 'team', label: '多 Agent 协作' }]} /></Field><Field id="default-runtime" label="默认 Runtime" hint="成员的默认模型来自此 Runtime 的配置。"><Picker id="default-runtime" label="新任务默认 Runtime" value={draft.defaultRuntime || '__none__'} onChange={value => { setDraft(current => ({ ...current, defaultRuntime: value === '__none__' ? '' : value })); setNotice(null) }} options={[{ value: '__none__', label: '创建时选择' }, ...draft.runtimes.map(item => ({ value: item.id, label: item.name + (item.enabled ? '' : '（已停用）'), disabled: !item.enabled, runtime: item }))]} /></Field><Field id="max-parallel" label="最大并行成员" hint="1–8 位。限制同时执行的成员数量，不会改变已运行的批次。"><Input id="max-parallel" type="number" min={1} max={8} step={1} className="max-w-36" value={draft.maxParallel || ''} onChange={event => { setDraft(current => ({ ...current, maxParallel: Number(event.target.value) })); setNotice(null) }} /></Field><Field id="default-directory" label="默认工作目录" hint="留空时在任务中选择；任务自身的工作目录优先。"><div className="flex gap-2"><Input id="default-directory" className="min-w-0 font-mono" placeholder="未指定默认目录" value={draft.defaultDirectory} onChange={event => { setDraft(current => ({ ...current, defaultDirectory: event.target.value })); setNotice(null) }} /><Button variant="outline" size="sm" onClick={() => void pickDirectory()}><FolderOpen className="size-3.5" />选择目录</Button></div></Field></Section><Section title="配置何时生效"><div className="space-y-3 text-xs leading-6 text-muted-foreground"><p>新建成员使用当前默认的 Runtime 和模型；已有成员保留各自选择。Runtime 的访问权限与启动配置会用于所有关联成员的下一次执行。</p><p>保存设置不会重启 {activeCount > 0 ? '当前 ' + activeCount + ' 个执行实例' : '执行实例'}，也不会改写历史聊天与执行记录。</p></div></Section></div>}

          {category === 'storage' && <div className="space-y-7"><div><h1 className="text-xl font-semibold">记录与存储</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">聊天、配置与 Runtime 公开事件存储在本机，可导出当前任务的记录。</p></div><Section title="本地数据" action={<Button variant="ghost" size="sm" disabled={storageLoading} onClick={() => void refreshStorage()}><RefreshCw className={'size-3.5 ' + (storageLoading ? 'animate-spin motion-reduce:animate-none' : '')} />刷新</Button>}><Field label="存储位置"><p className="min-h-8 break-all rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-xs">{storage?.path || (storageLoading ? '正在读取…' : '尚未获取')}</p></Field><Field label="存储占用"><p className="py-2 text-xs">{storage ? <span title={storage.bytes + ' bytes'}>{formatBytes(storage.bytes)} <span className="ml-2 text-[11px] text-muted-foreground">{storage.bytes.toLocaleString()} 字节</span></span> : '未读取'}</p></Field>{storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}<p className="text-[11px] leading-5 text-muted-foreground">{isDesktop ? '这是桌面应用当前实际使用的数据位置。' : '当前为浏览器预览存储；桌面应用使用独立的本地数据文件。'}现有记录不会自动过期。</p></Section><Section title="执行输出保留"><p className="text-xs leading-5 text-muted-foreground">完整保留每次执行的公开输出与 Trace，不再按累计字节数或记录条数截断。旧版本已丢弃的输出无法恢复。</p></Section><Section title="导出当前任务"><div className="flex items-center justify-between gap-6 rounded-md border border-border p-4"><div><p className="text-xs font-medium">聊天与执行记录</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">导出当前任务的聊天、成员配置与公开执行事件。</p></div><Button variant="outline" size="sm" onClick={onExport}><Download className="size-3.5" />导出任务</Button></div><p className="text-[11px] leading-5 text-muted-foreground">执行事件只包含 Runtime 公开的数据，不代表模型不可访问的内部思考。</p></Section></div>}
        </div></ScrollArea>
        <footer className="flex min-h-[76px] shrink-0 items-center justify-between gap-4 border-t border-border bg-sidebar px-6 py-3">
          <div className="min-w-0 space-y-1"><p className={'flex items-center gap-1.5 text-xs ' + (dirty ? 'text-accent-foreground' : 'text-muted-foreground')}><span className={'size-1.5 rounded-full ' + (dirty ? 'bg-accent-foreground' : 'bg-border')} />{saving ? '正在保存配置…' : dirty ? '有未保存的更改 · 切换分类会保留编辑' : '所有更改已保存'}</p><p role={notice?.error ? 'alert' : 'status'} aria-live="polite" className={'max-w-[620px] text-[11px] leading-4 ' + (notice?.error ? 'text-destructive' : 'text-muted-foreground')}>{notice?.text || '外观保存后立即生效；Runtime 配置用于下次执行。'}</p></div>
          <div className="flex shrink-0 items-center gap-2"><Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={reset}><RotateCcw className="size-3.5" />还原</Button><Button size="sm" disabled={!dirty || saving} onClick={() => void saveChanges()}>{saving ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Save className="size-3.5" />}{saving ? '保存中…' : '保存更改'}</Button></div>
        </footer>
      </main>
    </div>

    <Dialog open={discardTarget !== null} onOpenChange={open => { if (!open) setDiscardTarget(null) }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>放弃未保存的更改？</DialogTitle><DialogDescription>当前设置编辑尚未保存。{discardTarget === 'discover' ? '进入自动检测' : '返回工作台'}会丢弃这些更改，已保存配置和运行中的实例不受影响。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscardTarget(null)}>继续编辑</Button><Button variant="destructive" onClick={discardAndLeave}>{discardTarget === 'discover' ? '放弃更改并检测' : '放弃更改并返回'}</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={Boolean(newRuntime)} onOpenChange={open => { if (!open) setNewRuntime(null) }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>添加 Runtime</DialogTitle><DialogDescription>登记一个本机 CLI 或 Harness。添加后继续配置，点击页面底部保存才会持久化。</DialogDescription></DialogHeader>{newRuntime && <div className="space-y-4"><Field id="new-runtime-name" label="显示名称"><Input id="new-runtime-name" autoFocus placeholder="例如 DeepSeek Harness" value={newRuntime.name} onChange={event => { setNewRuntime({ ...newRuntime, name: event.target.value }); setEditorError('') }} /></Field><Field id="new-runtime-adapter" label="适配器"><Picker id="new-runtime-adapter" label="新 Runtime 适配器" value={newRuntime.adapter} options={adapters} onChange={value => setNewRuntime({ ...newRuntime, adapter: value as Adapter })} /></Field><Field id="new-runtime-executable" label="可执行文件" hint="可以稍后填写。新注册项默认停用，不会立即启动进程。"><Input id="new-runtime-executable" className="font-mono" placeholder="命令名称或文件路径" value={newRuntime.executable} onChange={event => setNewRuntime({ ...newRuntime, executable: event.target.value })} /></Field>{editorError && <p role="alert" className="text-xs text-destructive">{editorError}</p>}</div>}<DialogFooter><Button variant="outline" onClick={() => setNewRuntime(null)}>取消</Button><Button onClick={addRuntime}>添加到配置</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={Boolean(modelEditor)} onOpenChange={open => { if (!open) setModelEditor(null) }}><DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto"><DialogHeader><DialogTitle>{draft.models.some(item => item.id === modelEditor?.id) ? '编辑模型' : '添加模型'}</DialogTitle><DialogDescription>显示名称用于辨认，Model ID 会传给运行时。兼容关系需要与你使用的运行时配置一致。</DialogDescription></DialogHeader>{modelEditor && <div className="space-y-4"><Field id="model-name" label="显示名称"><Input id="model-name" value={modelEditor.name} onChange={event => { setModelEditor({ ...modelEditor, name: event.target.value }); setEditorError('') }} /></Field><Field id="model-id" label="Model ID"><Input id="model-id" className="font-mono" placeholder="运行时识别的实际模型 ID" value={modelEditor.modelId} onChange={event => { setModelEditor({ ...modelEditor, modelId: event.target.value, ...(event.target.value !== modelEditor.modelId ? { supportedReasoningEfforts: undefined, supportedReasoningEffortsByRuntime: undefined } : {}) }); setEditorError('') }} /></Field><Field id="model-provider" label="来源连接"><Picker id="model-provider" label="模型来源连接" value={modelEditor.providerId || '__runtime__'} onChange={value => setModelEditor({ ...modelEditor, providerId: value === '__runtime__' ? '' : value })} options={[{ value: '__runtime__', label: 'Runtime 自身配置' }, ...draft.providers.map(item => ({ value: item.id, label: item.name }))]} /></Field><Field label="兼容 Runtime"><div className="space-y-3 rounded-md border border-border p-3">{draft.runtimes.map(item => <div key={item.id} className="flex items-center justify-between gap-3"><Label htmlFor={'model-runtime-' + item.id} className="flex items-center gap-2 text-xs font-normal"><RuntimeLogo runtime={item} size={16} />{item.name}{!item.enabled && <span className="ml-1 text-muted-foreground">（已停用）</span>}</Label><Switch id={'model-runtime-' + item.id} checked={modelEditor.runtimeIds.includes(item.id)} onCheckedChange={checked => { setModelEditor({ ...modelEditor, runtimeIds: checked ? [...modelEditor.runtimeIds, item.id] : modelEditor.runtimeIds.filter(id => id !== item.id) }); setEditorError('') }} /></div>)}{!draft.runtimes.length && <p className="text-xs text-muted-foreground">请先添加 Runtime，或停用此模型以保留待绑定配置。</p>}</div></Field><Field id="model-reasoning" label="默认思考强度" hint="任务成员可单独覆盖。强度由所选模型支持，较高强度通常需要更多时间和 token。"><ReasoningEffortSelect id="model-reasoning" label="模型默认思考强度" value={modelEditor.reasoningEffort} options={getModelReasoningOptions(modelEditor, draft.runtimes)} onChange={value => { setModelEditor({ ...modelEditor, reasoningEffort: value as ReasoningEffort }); setEditorError('') }} />{modelEditor.reasoningEffort === 'ultra' && modelEditor.runtimeIds.some(id => draft.runtimes.find(item => item.id === id)?.adapter === 'codex') && <p className="text-[11px] leading-5 text-accent-foreground">ultra 可由 Codex 自动委派子任务。</p>}{modelEditor.runtimeIds.some(id => draft.runtimes.find(item => item.id === id)?.adapter === 'generic') && <p className="text-[11px] leading-5 text-muted-foreground">通用 CLI 的思考参数请在对应 Runtime 的高级启动配置中设置。</p>}</Field><Field id="model-enabled" label="启用模型"><div className="flex min-h-8 items-center gap-2"><Switch id="model-enabled" checked={modelEditor.enabled} onCheckedChange={enabled => { setModelEditor({ ...modelEditor, enabled }); setEditorError('') }} /><span className="text-xs text-muted-foreground">供相容的 Runtime 选择</span></div></Field>{editorError && <p role="alert" className="text-xs text-destructive">{editorError}</p>}</div>}<DialogFooter><Button variant="outline" onClick={() => setModelEditor(null)}>取消</Button><Button onClick={applyModel}>应用到配置</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={Boolean(providerEditor)} onOpenChange={open => { if (!open) setProviderEditor(null) }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{draft.providers.some(item => item.id === providerEditor?.id) ? '编辑供应商连接' : '登记供应商连接'}</DialogTitle><DialogDescription>仅登记模型来源信息。此处不测试连接、不读取密钥，也不自动覆盖运行时认证。</DialogDescription></DialogHeader>{providerEditor && <div className="space-y-4"><Field id="provider-name" label="连接名称"><Input id="provider-name" value={providerEditor.name} onChange={event => { setProviderEditor({ ...providerEditor, name: event.target.value }); setEditorError('') }} /></Field><Field id="provider-url" label="Base URL" hint="按需填写服务地址，不包含账号、密码或 API Key。"><Input id="provider-url" type="url" className="font-mono" placeholder="https://api.example.com/v1" value={providerEditor.baseUrl} onChange={event => { setProviderEditor({ ...providerEditor, baseUrl: event.target.value }); setEditorError('') }} /></Field><Field id="provider-env" label="凭据环境变量名" hint="只填写名称，例如 OPENAI_API_KEY；不是变量的值。本应用不会在此读取或注入它。"><Input id="provider-env" autoComplete="off" spellCheck={false} className="font-mono" placeholder="例如 OPENAI_API_KEY" value={providerEditor.credentialEnv} onChange={event => { setProviderEditor({ ...providerEditor, credentialEnv: event.target.value }); setEditorError('') }} /></Field>{editorError && <p role="alert" className="text-xs text-destructive">{editorError}</p>}</div>}<DialogFooter><Button variant="outline" onClick={() => setProviderEditor(null)}>取消</Button><Button onClick={applyProvider}>应用到配置</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

export default SettingsPage
