import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import type { FirstRunDiscovery } from './FirstRunEntry'
import { RuntimeLogo } from './RuntimeLogo'
import type { DiscoveredRuntime } from '@/lib/types'
import { useI18n } from '@/i18n'

const runnable = (runtime: DiscoveredRuntime) => runtime.probe.found && !runtime.probe.error && runtime.adapter !== 'generic'
const noRuntimes: DiscoveredRuntime[] = []

export function RuntimeStartPrompt({ open, intent, discovery, onOpenChange, onConfirm }: {
  open: boolean
  intent: 'choose' | 'run'
  discovery?: FirstRunDiscovery
  onOpenChange: (open: boolean) => void
  onConfirm: (runtimeId: string, remember: boolean) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const runtimes = discovery?.report?.runtimes ?? noRuntimes
  const selected = runtimes.find(runtime => runtime.id === selectedId)
  const ready = selected ? runnable(selected) : false

  useEffect(() => {
    if (!open) return
    const found = runtimes.filter(runnable)
    const fallback = found[0]?.id ?? runtimes[0]?.id ?? ''
    setSelectedId(current => found.some(runtime => runtime.id === current) ? current : fallback)
    setRemember(true)
    setLocalError('')
    setBusy(false)
  }, [open, runtimes])

  function status(runtime: DiscoveredRuntime) {
    if (!runtime.probe.found) return t('未安装', 'Not installed')
    if (runtime.probe.error || runtime.adapter === 'generic') return t('已检测到，还不能直接执行', 'Detected, not ready to run')
    return t('已检测到', 'Detected')
  }

  async function confirm() {
    if (!selected || !ready || busy) return
    setBusy(true)
    setLocalError('')
    try {
      const saved = await onConfirm(selected.id, remember)
      if (saved === false) return
      onOpenChange(false)
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  async function defer() {
    if (busy) return
    setBusy(true)
    setLocalError('')
    try {
      const saved = await discovery?.onDefer()
      if (saved === false) return
      onOpenChange(false)
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  const failure = localError || discovery?.error || ''
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="runtime-prompt-dialog">
      <DialogHeader>
        <DialogTitle>{t('由谁来执行？', 'Who should run this?')}</DialogTitle>
        <DialogDescription>{intent === 'run'
          ? t('只在第一次执行时确认 Runtime。目标本身已经保存。', 'Confirm the runtime only the first time you run. The goal is already saved.')
          : t('查看本机 Coding Agent。现在选择不会打断目标记录。', 'Review local coding agents. Choosing one now does not interrupt recording a goal.')}</DialogDescription>
      </DialogHeader>
      <div className="runtime-prompt" role="radiogroup" aria-label={t('本机 Runtime', 'Local runtimes')}>
        {discovery?.scanning && <p className="runtime-prompt-status" role="status"><Spinner className="size-3.5" aria-hidden="true" role="presentation" aria-label={undefined} />{t('正在检测本机 Runtime…', 'Detecting local runtimes…')}</p>}
        {!discovery?.scanning && runtimes.length === 0 && <p className="runtime-prompt-status">{t('还没有检测结果。可以重新检测，或稍后再配置。', 'No detection result yet. Scan again, or configure one later.')}</p>}
        {runtimes.map(runtime => <Button key={runtime.id} type="button" variant="outline" className="runtime-prompt-option" role="radio" aria-checked={runtime.id === selectedId} aria-label={`${runtime.name}，${status(runtime)}`} onClick={() => setSelectedId(runtime.id)}>
          <RuntimeLogo runtimeId={runtime.id} size={16} />
          <span><strong>{runtime.name}</strong><small>{status(runtime)}</small></span>
        </Button>)}
        <Label className="runtime-prompt-remember" htmlFor="runtime-remember">
          <Checkbox id="runtime-remember" checked={remember} onCheckedChange={checked => setRemember(checked === true)} />
          {t('记为默认执行者', 'Remember as the default runtime')}
        </Label>
        {failure && <p className="goal-form-error" role="alert">{failure}</p>}
      </div>
      <DialogFooter className="runtime-prompt-footer">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void defer()}>{t('稍后配置', 'Configure later')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('取消', 'Cancel')}</Button>
        <Button type="button" variant="outline" disabled={busy || discovery?.scanning} onClick={() => discovery?.onScan()}>{t('重新检测', 'Scan again')}</Button>
        <Button type="button" disabled={busy || !ready} onClick={() => void confirm()}>{busy ? t('正在保存…', 'Saving…') : selected ? intent === 'run' ? t(`用 ${selected.name} 开始`, `Start with ${selected.name}`) : t(`使用 ${selected.name}`, `Use ${selected.name}`) : t('选择 Runtime', 'Choose a runtime')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
