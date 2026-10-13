import { useEffect, useRef, useState } from 'react'
import { ImagePlus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { isDesktop } from '@/lib/bridge'
import { BACKGROUND_IMAGE_ACCEPT, chooseBackgroundImage } from '@/lib/background-image'
import type { AppearancePatch } from '@/lib/appearance'
import type { AppBackgroundImage } from '@/lib/types'
import { useI18n } from '@/i18n'

export interface BackgroundSettingsProps {
  image?: AppBackgroundImage
  imageOpacity?: number
  surfaceOpacity?: number
  onChange: (patch: AppearancePatch) => void
  loading?: boolean
  error?: string
  onRetry?: () => void
  disabled: boolean
}

function opacityValue(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback
}

function OpacityControl({ id, label, help, value, disabled, onChange }: { id: string; label: string; help: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
    <Label id={`${id}-label`} className="pt-2 text-xs leading-5 text-muted-foreground">{label}</Label>
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-8 items-center">
        <Slider value={[value]} min={0} max={100} step={1} disabled={disabled} onValueChange={values => onChange(values[0])} thumbProps={{ id, 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-help`, 'aria-valuetext': `${value}%` }} />
      </div>
      <p id={`${id}-help`} className="text-[11px] leading-5 text-muted-foreground">{help}</p>
    </div>
  </div>
}

export function BackgroundSettings({ image, imageOpacity, surfaceOpacity, onChange, loading = false, error, onRetry, disabled }: BackgroundSettingsProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  const lastFile = useRef<File | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current += 1 }
  }, [])

  async function selectImage(file?: File) {
    const sequence = ++request.current
    lastFile.current = file
    setImporting(true)
    setImportError('')
    try {
      const chosen = await chooseBackgroundImage(file)
      if (mounted.current && request.current === sequence && chosen) onChange({ backgroundImage: chosen })
    } catch (reason) {
      if (mounted.current && request.current === sequence) setImportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current && request.current === sequence) setImporting(false)
    }
  }
  function choose() {
    if (isDesktop) void selectImage()
    else if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.click()
    }
  }
  function remove() {
    request.current += 1
    lastFile.current = undefined
    setImporting(false)
    setImportError('')
    onChange({ backgroundImage: undefined })
  }
  const busy = importing || loading
  const controlsDisabled = disabled || !image || busy
  const failure = importError || error
  const canRetry = Boolean(importError || onRetry)
  return <section className="space-y-4" aria-labelledby="app-background-heading">
    <h3 id="app-background-heading" className="border-b border-border pb-2 text-[13px] font-semibold">{t('背景图', 'Background image')}</h3>
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
      <Label htmlFor="app-background-select" className="pt-2 text-xs text-muted-foreground">{t('App 全局背景图', 'App background image')}</Label>
      <div className="min-w-0 space-y-2">
        <div className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-border px-2">
          <ImagePlus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs" title={image?.name}>{image?.name || t('未设置背景图', 'No background image')}</span>
          <Button id="app-background-select" type="button" variant="ghost" size="sm" className="shrink-0" aria-label={image ? t('更换背景图', 'Replace background image') : t('选择背景图', 'Choose background image')} disabled={disabled || importing} onClick={choose}>{importing && <Spinner className="size-3.5" aria-hidden="true" />}{image ? t('更换', 'Replace') : t('选择图片', 'Choose image')}</Button>
          {image && <Button type="button" variant="ghost" size="icon-sm" aria-label={t('移除背景图', 'Remove background image')} title={t('移除背景图', 'Remove background image')} disabled={disabled} onClick={remove}><X className="size-3.5" /></Button>}
        </div>
        {!isDesktop && <input ref={inputRef} type="file" accept={BACKGROUND_IMAGE_ACCEPT} className="hidden" aria-label={t('背景图片文件', 'Background image file')} onChange={event => { const file = event.target.files?.[0]; if (file) void selectImage(file) }} />}
        <p className="text-[11px] leading-5 text-muted-foreground">{t('选择本地图片，覆盖工作台和设置页。图片会保存到应用存储，选择后立即生效并自动保存。', 'Choose a local image for the workbench and settings. The image is copied into app storage, applies immediately, and saves automatically.')}</p>
        {busy && <p role="status" className="text-[11px] leading-5 text-muted-foreground">{importing ? t('正在导入背景图…', 'Importing background image…') : t('正在读取背景图…', 'Loading background image…')}</p>}
        {failure && <div className="flex items-start justify-between gap-2"><p role="alert" className="min-w-0 break-words text-xs leading-5 text-destructive">{t('背景图无法加载：', 'Could not load background image: ')}{failure}</p>{canRetry && <Button type="button" variant="ghost" size="sm" disabled={disabled || busy} onClick={() => { if (importError) void selectImage(lastFile.current); else onRetry?.() }}><RefreshCw className="size-3.5" />{t('重试', 'Retry')}</Button>}</div>}
      </div>
    </div>
    <OpacityControl id="app-background-image-opacity" label={t('背景图不透明度', 'Background image opacity')} help={t('0% 隐藏图片，100% 显示原图。', '0% hides the image; 100% shows the original image.')} value={opacityValue(imageOpacity, 100)} disabled={controlsDisabled} onChange={value => onChange({ backgroundImageOpacity: value })} />
    <OpacityControl id="app-background-surface-opacity" label={t('界面背景不透明度', 'Interface background opacity')} help={t('100% 为实色背景，0% 为透明背景；文字和按钮不受影响。', '100% uses solid surfaces; 0% uses transparent surfaces. Text and buttons stay unchanged.')} value={opacityValue(surfaceOpacity, 85)} disabled={controlsDisabled} onChange={value => onChange({ backgroundSurfaceOpacity: value })} />
  </section>
}
