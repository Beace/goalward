import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Cpu, FileCode2, FolderOpen, Info, RefreshCw, Settings2, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DiscoveredRuntime, LocalDiscoveryReport, Settings } from '@/lib/types'
import { RuntimeLogo } from './RuntimeLogo'
import './setup.css'

export interface SetupPageProps {
  report: LocalDiscoveryReport | null
  scanning: boolean
  error: string
  busy: boolean
  settings: Settings
  mode: 'first-run' | 'rescan'
  onRescan: () => void
  onImport: (runtimeIds: string[], defaultRuntimeId: string) => Promise<void>
  onConfigure: (runtimeId?: string, category?: 'runtimes' | 'models') => void
  onLater: () => Promise<void>
}

const knownRuntimes = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'traex', name: 'TraeX' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness' },
  { id: 'kimi', name: 'Kimi CLI' },
]
const canDefault = (runtime: DiscoveredRuntime) => runtime.probe.found && !runtime.probe.error && runtime.adapter !== 'generic'
function status(runtime: DiscoveredRuntime) {
  if (!runtime.probe.found) return { label: '未找到', className: 'setup-status-muted' }
  if (runtime.probe.error) return { label: '版本检测异常', className: 'setup-status-attention' }
  if (runtime.adapter === 'generic') return { label: '需配置启动参数', className: 'setup-status-attention' }
  return { label: '已找到', className: 'setup-status-found' }
}

function SetupSteps({ name, onConfigure, onRescan, disabled }: { name?: string; onConfigure: () => void; onRescan: () => void; disabled: boolean }) {
  return <section className="setup-steps" aria-label="配置步骤">
    <h3>{name ? `配置 ${name}` : '开始使用前，完成这三步'}</h3>
    <ol>
      <li><span className="setup-step-number">1</span><div><strong>安装 Agent Runtime</strong><p>按照 {name ?? '所选 Runtime'} 的官方说明安装命令行程序。已有程序可以在设置中选择路径。</p></div></li>
      <li><span className="setup-step-number">2</span><div><strong>完成登录与模型配置</strong><p>在 Runtime 自身完成登录，选择模型或保留其默认配置。</p></div></li>
      <li><span className="setup-step-number">3</span><div><strong>重新检测并导入</strong><p>返回这里重新检测，将找到的 Runtime 和模型加入工作台。</p></div></li>
    </ol>
    <div className="setup-inline-actions"><Button onClick={onConfigure} disabled={disabled}><FolderOpen />手动配置</Button><Button variant="outline" onClick={onRescan} disabled={disabled}><RefreshCw />重新检测</Button></div>
  </section>
}

export default function SetupPage({ report, scanning, error, busy, settings, mode, onRescan, onImport, onConfigure, onLater }: SetupPageProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [focusedId, setFocusedId] = useState('')
  const [defaultId, setDefaultId] = useState('')
  const [actionError, setActionError] = useState('')
  const [acting, setActing] = useState(false)
  const actionInFlight = useRef(false)
  const runtimes = report?.runtimes ?? []
  const found = runtimes.filter(runtime => runtime.probe.found)
  const eligible = runtimes.filter(canDefault)
  const selected = runtimes.filter(runtime => runtime.probe.found && selectedIds.includes(runtime.id))
  const defaultOptions = selected.filter(canDefault)
  const focused = runtimes.find(runtime => runtime.id === focusedId) ?? runtimes[0]
  const disabled = busy || acting || scanning
  const failure = error || actionError

  useEffect(() => {
    if (!report) return
    const ready = report.runtimes.filter(canDefault)
    setSelectedIds(ready.map(runtime => runtime.id))
    setFocusedId(ready[0]?.id ?? report.runtimes.find(runtime => runtime.probe.found)?.id ?? report.runtimes[0]?.id ?? '')
    setDefaultId(ready.some(runtime => runtime.id === settings.defaultRuntime) ? settings.defaultRuntime : ready[0]?.id ?? '')
    setActionError('')
    // A completed scan initializes a fresh set of choices. Saving settings alone must not reset them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report])

  function toggle(runtime: DiscoveredRuntime, checked: boolean) {
    setSelectedIds(current => checked ? [...current.filter(id => id !== runtime.id), runtime.id] : current.filter(id => id !== runtime.id))
    setFocusedId(runtime.id)
    if (!checked && defaultId === runtime.id) setDefaultId(eligible.find(item => item.id !== runtime.id && selectedIds.includes(item.id))?.id ?? '')
    if (checked && !defaultId && canDefault(runtime)) setDefaultId(runtime.id)
  }
  async function perform(action: () => Promise<void>, allowScanning = false) {
    if (actionInFlight.current || busy || acting || (!allowScanning && scanning)) return
    actionInFlight.current = true
    setActing(true)
    setActionError('')
    try { await action() } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { actionInFlight.current = false; setActing(false) }
  }
  const safeDefault = defaultOptions.some(runtime => runtime.id === defaultId) ? defaultId : ''

  return <main className="setup-page" aria-labelledby="setup-title">
    <header className="setup-header">
      <div><div className="setup-eyebrow"><Terminal className="size-3.5" />Goalward<ChevronRight className="size-3" />{mode === 'first-run' ? '初次设置' : '本机检测'}</div><h1 id="setup-title">{mode === 'first-run' ? '连接你的 Agent Runtime' : '检测本机 Runtime 与模型'}</h1><p>识别本机已有的运行时和模型配置，选择后即可加入工作台。</p></div>
      <Button variant="outline" onClick={onRescan} disabled={disabled}><RefreshCw />{scanning ? '正在检测…' : '重新检测'}</Button>
    </header>
    <div className="setup-scan-summary" role="status" aria-live="polite">
      {scanning ? <><RefreshCw className="size-4" /><span>正在检查本机可执行程序和模型配置…</span><span className="setup-summary-detail">完成后显示可导入项</span></> : report ? <><CheckCircle2 className="size-4" /><span>检测完成 · 找到 {found.length} 个 Runtime</span><span className="setup-summary-detail">{runtimes.reduce((total, runtime) => total + runtime.models.length, 0)} 项模型配置</span></> : <><Info className="size-4" /><span>{failure ? '检测未完成' : '准备检测本机配置'}</span></>}
    </div>
    {failure && <div className="setup-error" role="alert"><AlertCircle className="size-4" /><span>{failure}</span></div>}
    <div className="setup-panels" aria-busy={scanning}>
      <section className="setup-runtime-list" aria-label="Runtime 检测结果">
        <div className="setup-section-heading"><h2>本机 Runtime</h2><span>{report ? `${found.length} / ${runtimes.length} 已找到` : `${knownRuntimes.length} 项检查`}</span></div>
        <ScrollArea className="setup-list-scroll">
          {report ? runtimes.map(runtime => {
            const currentStatus = status(runtime)
            return <div key={runtime.id} className={`setup-runtime-row ${focused?.id === runtime.id ? 'setup-runtime-focused' : ''}`}>
              <Checkbox checked={selectedIds.includes(runtime.id)} onCheckedChange={checked => toggle(runtime, checked === true)} disabled={disabled || !runtime.probe.found} aria-label={`导入 ${runtime.name}`} />
              <Button variant="ghost" className="setup-runtime-select" aria-label={`查看 ${runtime.name} 检测详情`} aria-pressed={focused?.id === runtime.id} onClick={() => setFocusedId(runtime.id)}>
                <span className="setup-runtime-title"><RuntimeLogo runtime={runtime} size={16} /><strong>{runtime.name}</strong></span>
                <span className={`setup-runtime-state ${currentStatus.className}`}><span className="setup-status-dot" />{currentStatus.label}{runtime.probe.found && <span className="setup-runtime-count">{runtime.models.length} 项模型</span>}</span>
                <span className="setup-runtime-path">{runtime.probe.path || runtime.executable}</span>
              </Button>
            </div>
          }) : knownRuntimes.map(runtime => <div className="setup-pending-runtime" key={runtime.id}><RuntimeLogo runtimeId={runtime.id} size={16} /><span>{runtime.name}</span><span>{scanning ? '检测中' : '待检测'}</span></div>)}
        </ScrollArea>
        <div className="setup-list-note"><Info className="size-3.5" /><p>仅勾选需要导入的 Runtime。导入会合并配置，保留已有手动设置。</p></div>
      </section>
      <ScrollArea className="setup-detail-scroll">
        <div className="setup-detail">
          {!report ? <div className="setup-waiting"><div className="setup-waiting-icon"><Cpu className="size-6" /></div><h2>{scanning ? '正在查找你的本机配置' : failure ? '可以重试检测，或手动配置' : '准备连接本机运行时'}</h2><p>检查 Codex、Claude Code、TraeX、Kimi、Pi 和 DeepSeek Harness，以及已知位置的模型配置。</p><p className="setup-muted">读取本地配置并查询 TraeX / Pi 模型列表；不导入密钥。</p>{!scanning && <SetupSteps onConfigure={() => onConfigure()} onRescan={onRescan} disabled={disabled} />}</div> : focused ? <>
            <div className="setup-detail-heading"><div className="setup-runtime-detail-title"><RuntimeLogo runtime={focused} size={20} /><h2>{focused.name}</h2><Badge variant="outline" className={status(focused).className}>{status(focused).label}</Badge></div><Button variant="ghost" onClick={() => onConfigure(focused.id, 'runtimes')} disabled={disabled}><Settings2 />设置</Button></div>
            {!focused.probe.found ? <><p className="setup-detail-intro">{found.length === 0 ? '尚未找到可导入的本机 Runtime。可以安装后重新检测，或选择已安装程序的路径。' : `未在常见安装位置找到 ${focused.name}。`}</p><SetupSteps name={focused.name} onConfigure={() => onConfigure(focused.id, 'runtimes')} onRescan={onRescan} disabled={disabled} /></> : <>
              <dl className="setup-runtime-facts"><div><dt>可执行文件</dt><dd className="setup-code">{focused.probe.path || focused.executable}</dd></div><div><dt>程序版本</dt><dd className="setup-code">{focused.probe.version || '未获取到版本'}</dd></div><div><dt>连接方式</dt><dd>{focused.adapter === 'generic' ? '通用 CLI · 需确认非交互启动参数' : `${focused.name} 内置适配器`}</dd></div></dl>
              {focused.probe.error && <div className="setup-attention"><AlertCircle className="size-4" /><div><strong>找到程序，但版本检测未成功</strong><p>{focused.probe.error}</p><p>可以导入路径，之后在设置中检查可执行文件。</p></div></div>}
              {focused.adapter === 'generic' && <div className="setup-attention"><Info className="size-4" /><div><strong>需要补充通用启动参数</strong><p>导入后请到运行时设置中确认非交互参数、输入方式，再启用执行。</p><Button variant="link" onClick={() => onConfigure(focused.id, 'runtimes')} disabled={disabled}>配置启动参数<ArrowRight /></Button></div></div>}
              <section className="setup-model-section"><div className="setup-section-heading"><h3><Cpu className="size-4" />识别到的模型</h3><Button variant="ghost" size="sm" onClick={() => onConfigure(focused.id, 'models')} disabled={disabled}>配置模型<ArrowRight /></Button></div>
                {focused.models.length ? <div className="setup-model-list">{focused.models.map((model, index) => <div className="setup-model-row" key={`${model.modelId}:${model.source}:${index}`}><div className="setup-model-main"><strong>{model.name || model.modelId}</strong>{model.selected && <Badge variant="outline">本机配置默认</Badge>}</div><code>{model.modelId}</code><p><FileCode2 className="size-3.5" /><span>{model.source}</span></p></div>)}</div> : <div className="setup-model-empty"><Cpu className="size-5" /><div><h4>未读到显式模型</h4><p>可沿用 Runtime 自身默认，也可手动配置。</p></div></div>}
              </section>
              {focused.configSources.length > 0 && <section className="setup-source-section"><h3>读取来源</h3>{focused.configSources.map(source => <p key={source}><FileCode2 className="size-3.5" /><code>{source}</code></p>)}</section>}
              {focused.warnings.length > 0 && <section className="setup-discovery-notes" aria-label="检测说明"><h3>检测说明</h3>{focused.warnings.map((warning, index) => <p key={index}><Info className="size-3.5" /><span>{warning}</span></p>)}</section>}
            </>}
          </> : <SetupSteps onConfigure={() => onConfigure()} onRescan={onRescan} disabled={disabled} />}
        </div>
      </ScrollArea>
    </div>
    <footer className="setup-footer">
      <div className="setup-footer-top"><div className="setup-default-control"><Label htmlFor="setup-default-runtime">默认 Runtime</Label><Select value={safeDefault || '__keep__'} onValueChange={value => setDefaultId(value === '__keep__' ? '' : value)} disabled={disabled || defaultOptions.length === 0}><SelectTrigger id="setup-default-runtime" aria-label="默认 Runtime"><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="__keep__">暂不更改默认</SelectItem>{defaultOptions.map(runtime => <SelectItem key={runtime.id} value={runtime.id} textValue={runtime.name}><span className="inline-flex items-center gap-2"><RuntimeLogo runtime={runtime} size={16} /><span>{runtime.name}</span></span></SelectItem>)}</SelectContent></Select></div><div className="setup-footer-actions"><Button variant="ghost" onClick={() => void perform(onLater, true)} disabled={busy || acting}>{mode === 'rescan' && <ArrowLeft />}{mode === 'first-run' ? '稍后配置' : '返回工作台'}</Button>{!scanning && found.length === 0 ? <Button onClick={() => onConfigure()} disabled={disabled}><Settings2 />手动配置<ArrowRight /></Button> : <Button onClick={() => void perform(() => onImport(selected.map(runtime => runtime.id), safeDefault))} disabled={disabled || selected.length === 0}><Check />{busy || acting ? '正在保存…' : `导入所选 ${selected.length} 项并继续`}<ArrowRight /></Button>}</div></div>
      <p className="setup-footer-note"><Info className="size-3" />不导入密钥；TraeX 查询模型列表可能联网。识别到模型不代表实际调用已验证。</p>
    </footer>
  </main>
}
