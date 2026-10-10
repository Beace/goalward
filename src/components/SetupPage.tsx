import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Cpu, FileCode2, FolderOpen, Info, RefreshCw, Settings2, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DiscoveredRuntime, LocalDiscoveryReport, Settings } from '@/lib/types'
import { translate, useI18n } from '@/i18n'
import { localizeNativeDiagnostic, localizeNativeModelSource } from '@/lib/native-diagnostics'
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
  { id: 'pi', name: 'Pi' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness' },
  { id: 'kimi', name: 'Kimi CLI' },
]
const canDefault = (runtime: DiscoveredRuntime) => runtime.probe.found && !runtime.probe.error && runtime.adapter !== 'generic'
function status(runtime: DiscoveredRuntime) {
  if (!runtime.probe.found) return { label: translate('未找到', 'Not found'), className: 'setup-status-muted' }
  if (runtime.probe.error) return { label: translate('版本检测异常', 'Version check failed'), className: 'setup-status-attention' }
  if (runtime.adapter === 'generic') return { label: translate('需配置启动参数', 'Launch options needed'), className: 'setup-status-attention' }
  return { label: translate('已找到', 'Found'), className: 'setup-status-found' }
}

function SetupSteps({ name, onConfigure, onRescan, disabled }: { name?: string; onConfigure: () => void; onRescan: () => void; disabled: boolean }) {
  const { t } = useI18n()
  return <section className="setup-steps" aria-label={t('配置步骤', 'Setup steps')}>
    <h3>{name ? `${t('配置', 'Configure')} ${name}` : t('开始使用前，完成这三步', 'Complete these three steps to get started')}</h3>
    <ol>
      <li><span className="setup-step-number">1</span><div><strong>{t('安装 Agent Runtime', 'Install an Agent runtime')}</strong><p>{t('按照', 'Follow')} {name ?? t('所选 Runtime', 'the selected runtime')} {t('的官方说明安装命令行程序。已有程序可以在设置中选择路径。', 'official instructions to install its CLI. You can select an existing executable in Settings.')}</p></div></li>
      <li><span className="setup-step-number">2</span><div><strong>{t('完成登录与模型配置', 'Sign in and configure a model')}</strong><p>{t('在 Runtime 自身完成登录，选择模型或保留其默认配置。', 'Sign in through the runtime and choose a model, or keep its default.')}</p></div></li>
      <li><span className="setup-step-number">3</span><div><strong>{t('重新检测并导入', 'Rescan and import')}</strong><p>{t('返回这里重新检测，将找到的 Runtime 和模型加入工作台。', 'Rescan here, then add discovered runtimes and models to the workbench.')}</p></div></li>
    </ol>
    <div className="setup-inline-actions"><Button onClick={onConfigure} disabled={disabled}><FolderOpen />{t('手动配置', 'Configure manually')}</Button><Button variant="outline" onClick={onRescan} disabled={disabled}><RefreshCw />{t('重新检测', 'Rescan')}</Button></div>
  </section>
}

export default function SetupPage({ report, scanning, error, busy, settings, mode, onRescan, onImport, onConfigure, onLater }: SetupPageProps) {
  const { language, t } = useI18n()
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
      <div><div className="setup-eyebrow"><Terminal className="size-3.5" />Goalward<ChevronRight className="size-3" />{mode === 'first-run' ? t('初次设置', 'First-time setup') : t('本机检测', 'Local discovery')}</div><h1 id="setup-title">{mode === 'first-run' ? t('连接你的 Agent Runtime', 'Connect your Agent runtimes') : t('检测本机 Runtime 与模型', 'Discover local runtimes and models')}</h1><p>{t('识别本机已有的运行时和模型配置，选择后即可加入工作台。', 'Find installed runtimes and model settings, then add the ones you want to the workbench.')}</p></div>
      <Button variant="outline" onClick={onRescan} disabled={disabled}><RefreshCw />{scanning ? t('正在检测…', 'Scanning…') : t('重新检测', 'Rescan')}</Button>
    </header>
    <div className="setup-scan-summary" role="status" aria-live="polite">
      {scanning ? <><RefreshCw className="size-4" /><span>{t('正在检查本机可执行程序和模型配置…', 'Checking local executables and model settings…')}</span><span className="setup-summary-detail">{t('完成后显示可导入项', 'Import options will appear when complete')}</span></> : report ? <><CheckCircle2 className="size-4" /><span>{t('检测完成 · 找到', 'Scan complete · Found')} {found.length} {t('个 Runtime', 'runtimes')}</span><span className="setup-summary-detail">{runtimes.reduce((total, runtime) => total + runtime.models.length, 0)} {t('项模型配置', 'model settings')}</span></> : <><Info className="size-4" /><span>{failure ? t('检测未完成', 'Scan incomplete') : t('准备检测本机配置', 'Ready to scan local settings')}</span></>}
    </div>
    {failure && <div className="setup-error" role="alert"><AlertCircle className="size-4" /><span>{localizeNativeDiagnostic(failure, language)}</span></div>}
    <div className="setup-panels" aria-busy={scanning}>
      <section className="setup-runtime-list" aria-label={t('Runtime 检测结果', 'Runtime scan results')}>
        <div className="setup-section-heading"><h2>{t('本机 Runtime', 'Local runtimes')}</h2><span>{report ? `${found.length} / ${runtimes.length} ${t('已找到', 'found')}` : `${knownRuntimes.length} ${t('项检查', 'checks')}`}</span></div>
        <ScrollArea className="setup-list-scroll">
          {report ? runtimes.map(runtime => {
            const currentStatus = status(runtime)
            return <div key={runtime.id} className={`setup-runtime-row ${focused?.id === runtime.id ? 'setup-runtime-focused' : ''}`}>
              <Checkbox checked={selectedIds.includes(runtime.id)} onCheckedChange={checked => toggle(runtime, checked === true)} disabled={disabled || !runtime.probe.found} aria-label={`${t('导入', 'Import')} ${runtime.name}`} />
              <Button variant="ghost" className="setup-runtime-select" aria-label={`${t('查看', 'View')} ${runtime.name} ${t('检测详情', 'scan details')}`} aria-pressed={focused?.id === runtime.id} onClick={() => setFocusedId(runtime.id)}>
                <span className="setup-runtime-title"><RuntimeLogo runtime={runtime} size={16} /><strong>{runtime.name}</strong></span>
                <span className={`setup-runtime-state ${currentStatus.className}`}><span className="setup-status-dot" />{currentStatus.label}{runtime.probe.found && <span className="setup-runtime-count">{runtime.models.length} {t('项模型', 'models')}</span>}</span>
                <span className="setup-runtime-path">{runtime.probe.path || runtime.executable}</span>
              </Button>
            </div>
          }) : knownRuntimes.map(runtime => <div className="setup-pending-runtime" key={runtime.id}><RuntimeLogo runtimeId={runtime.id} size={16} /><span>{runtime.name}</span><span>{scanning ? t('检测中', 'Scanning') : t('待检测', 'Pending')}</span></div>)}
        </ScrollArea>
        <div className="setup-list-note"><Info className="size-3.5" /><p>{t('仅勾选需要导入的 Runtime。导入会合并配置，保留已有手动设置。', 'Select only the runtimes you want to import. Import merges settings and preserves manual changes.')}</p></div>
      </section>
      <ScrollArea className="setup-detail-scroll">
        <div className="setup-detail">
          {!report ? <div className="setup-waiting"><div className="setup-waiting-icon"><Cpu className="size-6" /></div><h2>{scanning ? t('正在查找你的本机配置', 'Searching local settings') : failure ? t('可以重试检测，或手动配置', 'Retry scanning or configure manually') : t('准备连接本机运行时', 'Ready to connect local runtimes')}</h2><p>{t('检查 Codex、Claude Code、Kimi、Pi 和 DeepSeek Harness，以及已知位置的模型配置。', 'Check Codex, Claude Code, Kimi, Pi, DeepSeek Harness, and model settings in known locations.')}</p><p className="setup-muted">{t('读取本地配置并查询 Pi 模型列表；不导入密钥。', 'Read local settings and query Pi model lists; no secrets are imported.')}</p>{!scanning && <SetupSteps onConfigure={() => onConfigure()} onRescan={onRescan} disabled={disabled} />}</div> : focused ? <>
            <div className="setup-detail-heading"><div className="setup-runtime-detail-title"><RuntimeLogo runtime={focused} size={20} /><h2>{focused.name}</h2><Badge variant="outline" className={status(focused).className}>{status(focused).label}</Badge></div><Button variant="ghost" onClick={() => onConfigure(focused.id, 'runtimes')} disabled={disabled}><Settings2 />{t('设置', 'Settings')}</Button></div>
            {!focused.probe.found ? <><p className="setup-detail-intro">{found.length === 0 ? t('尚未找到可导入的本机 Runtime。可以安装后重新检测，或选择已安装程序的路径。', 'No importable runtimes found. Install one and rescan, or choose an existing executable.') : `${t('未在常见安装位置找到', 'Not found in common install locations:')} ${focused.name}.`}</p><SetupSteps name={focused.name} onConfigure={() => onConfigure(focused.id, 'runtimes')} onRescan={onRescan} disabled={disabled} /></> : <>
              <dl className="setup-runtime-facts"><div><dt>{t('可执行文件', 'Executable')}</dt><dd className="setup-code">{focused.probe.path || focused.executable}</dd></div><div><dt>{t('程序版本', 'Version')}</dt><dd className="setup-code">{focused.probe.version || t('未获取到版本', 'Version unavailable')}</dd></div><div><dt>{t('连接方式', 'Connection')}</dt><dd>{focused.adapter === 'generic' ? t('通用 CLI · 需确认非交互启动参数', 'Generic CLI · Confirm non-interactive launch options') : `${focused.name} ${t('内置适配器', 'built-in adapter')}`}</dd></div></dl>
              {focused.probe.error && <div className="setup-attention"><AlertCircle className="size-4" /><div><strong>{t('找到程序，但版本检测未成功', 'Executable found, but version check failed')}</strong><p>{localizeNativeDiagnostic(focused.probe.error, language)}</p><p>{t('可以导入路径，之后在设置中检查可执行文件。', 'You can import its path and check the executable later in Settings.')}</p></div></div>}
              {focused.adapter === 'generic' && <div className="setup-attention"><Info className="size-4" /><div><strong>{t('需要补充通用启动参数', 'Generic launch options needed')}</strong><p>{t('导入后请到运行时设置中确认非交互参数、输入方式，再启用执行。', 'After importing, confirm non-interactive options and input mode in Runtime Settings before enabling runs.')}</p><Button variant="link" onClick={() => onConfigure(focused.id, 'runtimes')} disabled={disabled}>{t('配置启动参数', 'Configure launch options')}<ArrowRight /></Button></div></div>}
              <section className="setup-model-section"><div className="setup-section-heading"><h3><Cpu className="size-4" />{t('识别到的模型', 'Discovered models')}</h3><Button variant="ghost" size="sm" onClick={() => onConfigure(focused.id, 'models')} disabled={disabled}>{t('配置模型', 'Configure models')}<ArrowRight /></Button></div>
                {focused.models.length ? <div className="setup-model-list">{focused.models.map((model, index) => <div className="setup-model-row" key={`${model.modelId}:${model.source}:${index}`}><div className="setup-model-main"><strong>{model.name || model.modelId}</strong>{model.selected && <Badge variant="outline">{t('本机配置默认', 'Local default')}</Badge>}</div><code>{model.modelId}</code><p><FileCode2 className="size-3.5" /><span>{localizeNativeModelSource(model.source, language)}</span></p></div>)}</div> : <div className="setup-model-empty"><Cpu className="size-5" /><div><h4>{t('未读到显式模型', 'No explicit models found')}</h4><p>{t('可沿用 Runtime 自身默认，也可手动配置。', 'Use the runtime default or configure a model manually.')}</p></div></div>}
              </section>
              {focused.configSources.length > 0 && <section className="setup-source-section"><h3>{t('读取来源', 'Sources read')}</h3>{focused.configSources.map(source => <p key={source}><FileCode2 className="size-3.5" /><code>{source}</code></p>)}</section>}
              {focused.warnings.length > 0 && <section className="setup-discovery-notes" aria-label={t('检测说明', 'Scan notes')}><h3>{t('检测说明', 'Scan notes')}</h3>{focused.warnings.map((warning, index) => <p key={index}><Info className="size-3.5" /><span>{localizeNativeDiagnostic(warning, language)}</span></p>)}</section>}
            </>}
          </> : <SetupSteps onConfigure={() => onConfigure()} onRescan={onRescan} disabled={disabled} />}
        </div>
      </ScrollArea>
    </div>
    <footer className="setup-footer">
      <div className="setup-footer-top"><div className="setup-default-control"><Label htmlFor="setup-default-runtime">{t('默认 Runtime', 'Default runtime')}</Label><Select value={safeDefault || '__keep__'} onValueChange={value => setDefaultId(value === '__keep__' ? '' : value)} disabled={disabled || defaultOptions.length === 0}><SelectTrigger id="setup-default-runtime" aria-label={t('默认 Runtime', 'Default runtime')}><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="__keep__">{t('暂不更改默认', 'Keep current default')}</SelectItem>{defaultOptions.map(runtime => <SelectItem key={runtime.id} value={runtime.id} textValue={runtime.name}><span className="inline-flex items-center gap-2"><RuntimeLogo runtime={runtime} size={16} /><span>{runtime.name}</span></span></SelectItem>)}</SelectContent></Select></div><div className="setup-footer-actions"><Button variant="ghost" onClick={() => void perform(onLater, true)} disabled={busy || acting}>{mode === 'rescan' && <ArrowLeft />}{mode === 'first-run' ? t('稍后配置', 'Set up later') : t('返回工作台', 'Back to workbench')}</Button>{!scanning && found.length === 0 ? <Button onClick={() => onConfigure()} disabled={disabled}><Settings2 />{t('手动配置', 'Configure manually')}<ArrowRight /></Button> : <Button onClick={() => void perform(() => onImport(selected.map(runtime => runtime.id), safeDefault))} disabled={disabled || selected.length === 0}><Check />{busy || acting ? t('正在保存…', 'Saving…') : `${t('导入所选', 'Import selected')} ${selected.length} ${t('项并继续', 'and continue')}`}<ArrowRight /></Button>}</div></div>
      <p className="setup-footer-note"><Info className="size-3" />{t('不导入密钥；Pi 查询模型列表可能联网。识别到模型不代表实际调用已验证。', 'Secrets are not imported. Querying Pi models may use the network. Discovered models are not yet verified for actual use.')}</p>
    </footer>
  </main>
}
