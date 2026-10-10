import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { isDesktop, listSystemFonts } from '@/lib/bridge'
import { normalizeFontFamily, uiFontStack } from '@/lib/fonts'
import { useI18n } from '@/i18n'
import type { ThemePreference } from '@/lib/types'

export function AppearanceSettings({ value, onChange, themeValue = 'system', onThemeChange, languagePreference, onLanguageChange, disabled }: { value?: string; onChange: (family: string) => void; themeValue?: ThemePreference; onThemeChange: (theme: ThemePreference) => void; languagePreference?: 'zh' | 'en'; onLanguageChange: (language?: 'zh' | 'en') => void; disabled: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [families, setFamilies] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const selected = normalizeFontFamily(value)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listSystemFonts().then(fonts => {
      if (!cancelled) setFamilies([...new Set(fonts.map(normalizeFontFamily).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [revision])
  const options = selected && !families.includes(selected) ? [selected, ...families] : families
  function select(family: string) { onChange(family); setOpen(false) }
  return <div className="space-y-7">
    <div><h1 className="text-xl font-semibold">{t('外观', 'Appearance')}</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('调整应用主题、语言与界面字体。选择后立即生效并自动保存。', 'Choose the app theme, language, and interface font. Changes apply immediately and save automatically.')}</p></div>
    <section className="space-y-4">
      <h3 className="border-b border-border pb-2 text-[13px] font-semibold">{t('主题', 'Theme')}</h3>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
        <Label htmlFor="app-theme" className="pt-2 text-xs text-muted-foreground">{t('界面主题', 'Interface theme')}</Label>
        <div className="min-w-0 space-y-2">
          <Select value={themeValue} onValueChange={theme => onThemeChange(theme as ThemePreference)} disabled={disabled} motion>
            <SelectTrigger id="app-theme" aria-label={t('界面主题', 'Interface theme')} aria-describedby="app-theme-help" className="w-full min-w-0"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="system">{t('跟随系统', 'Follow system')}</SelectItem>
              <SelectItem value="dark">{t('深色', 'Dark')}</SelectItem>
              <SelectItem value="light">{t('浅色', 'Light')}</SelectItem>
            </SelectContent>
          </Select>
          <p id="app-theme-help" className="text-[11px] leading-5 text-muted-foreground">{t('「跟随系统」会随操作系统的深浅色设置自动切换。主题选择立即生效并自动保存，下次启动继续使用。', 'Follow system switches with the operating system appearance. Theme changes apply immediately, save automatically, and persist across launches.')}</p>
        </div>
      </div>
    </section>
    <section className="space-y-4">
      <h3 className="border-b border-border pb-2 text-[13px] font-semibold">{t('语言', 'Language')}</h3>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
        <Label htmlFor="app-language" className="pt-2 text-xs text-muted-foreground">{t('界面语言', 'Interface language')}</Label>
        <div className="min-w-0 space-y-2">
          <Select value={languagePreference ?? 'system'} onValueChange={choice => onLanguageChange(choice === 'system' ? undefined : choice as 'zh' | 'en')} disabled={disabled} motion>
            <SelectTrigger id="app-language" aria-label={t('界面语言', 'Interface language')} aria-describedby="app-language-help" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="system">{t('跟随系统', 'Follow system')}</SelectItem>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <p id="app-language-help" className="text-[11px] leading-5 text-muted-foreground">{t('跟随系统时，中文系统使用中文，其他语言使用英文。选择后立即切换并自动保存。', 'Follow system uses Chinese for Chinese system locales and English otherwise. Language changes apply immediately and save automatically.')}</p>
        </div>
      </div>
    </section>
    <section className="space-y-4">
      <h3 className="border-b border-border pb-2 text-[13px] font-semibold">{t('字体', 'Font')}</h3>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
        <Label htmlFor="app-font" className="pt-2 text-xs text-muted-foreground">{t('界面字体', 'Interface font')}</Label>
        <div className="min-w-0 space-y-2">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild><Button id="app-font" variant="outline" role="combobox" aria-label={t('界面字体', 'Interface font')} aria-expanded={open} disabled={disabled} className="w-full justify-between gap-2 font-normal"><span className="truncate">{selected || t('应用默认（Inter / 系统字体）', 'App default (Inter / system font)')}</span><ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" /></Button></PopoverTrigger>
            <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
              <Command><CommandInput placeholder={t('搜索字体…', 'Search fonts…')} aria-label={t('搜索字体', 'Search fonts')} /><CommandList className="max-h-[min(300px,var(--radix-popover-content-available-height))]" aria-label={t('可用字体', 'Available fonts')}>
                <CommandEmpty>{t('没有匹配的字体', 'No matching fonts')}</CommandEmpty>
                <CommandItem value={t('应用默认 Inter 系统字体', 'App default Inter system font')} onSelect={() => select('')}><Check className={'size-3.5 ' + (selected ? 'opacity-0' : '')} />{t('应用默认（Inter / 系统字体）', 'App default (Inter / system font)')}</CommandItem>
                {options.map(family => <CommandItem key={family} value={family} onSelect={() => select(family)}><Check className={'size-3.5 ' + (selected === family ? '' : 'opacity-0')} /><span className="truncate">{family}</span></CommandItem>)}
              </CommandList></Command>
            </PopoverContent>
          </Popover>
          <p className="text-[11px] leading-5 text-muted-foreground">{t('选择后立即应用于工作台、聊天和设置页，并自动保存，下次启动继续使用。代码与执行日志保留等宽字体；缺失的字形自动使用系统字体。', 'Font changes apply immediately throughout the app, save automatically, and persist across launches. Code and execution logs stay monospaced; missing glyphs use a system fallback.')}</p>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span role="status">{loading ? t('正在读取字体…', 'Loading fonts…') : isDesktop ? t(`本机可用字体 · ${families.length} 款`, `Available system fonts · ${families.length}`) : t('浏览器预览提供常用字体；桌面应用显示本机字体。', 'Browser preview shows common fonts; the desktop app shows installed fonts.')}</span><Button variant="ghost" size="sm" disabled={loading || disabled} onClick={() => setRevision(current => current + 1)}><RefreshCw className="size-3.5" />{t('刷新', 'Refresh')}</Button></div>
          {error && <p role="alert" className="text-xs text-destructive">{t('无法读取本机字体：', 'Could not load system fonts: ')}{error}{t('。可点击刷新重试，或选择应用默认。', '. Refresh to retry, or choose the app default.')}</p>}
          {!loading && !error && isDesktop && selected && !families.includes(selected) && <p role="status" className="text-xs text-muted-foreground">{t('本机未找到已选字体，将使用默认字体回退。', 'The selected font was not found; the app will use its default font.')}</p>}
        </div>
      </div>
    </section>
    <section className="space-y-3"><h3 className="text-[13px] font-semibold">{t('预览', 'Preview')}</h3><div data-testid="font-preview" className="space-y-2 rounded-md border border-border bg-surface-inset p-4" style={{ fontFamily: uiFontStack(selected) }}><p className="text-sm">{t('让每个 Agent 专注于目标，让协作清晰可见。', 'Keep every agent focused on the goal and every collaboration clear.')}</p><p className="text-sm">The quick brown fox jumps over the lazy dog.</p><p className="text-xs text-muted-foreground">Runtime · {t('模型 · 任务', 'Model · Task')} · 0123456789</p></div><p className="text-[11px] text-muted-foreground">{t('预览当前字体的中英文与数字显示效果。', 'Preview how the current font displays Chinese, English, and numbers.')}</p></section>
  </div>
}
