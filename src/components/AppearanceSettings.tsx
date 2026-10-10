import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { isDesktop, listSystemFonts } from '@/lib/bridge'
import { normalizeFontFamily, uiFontStack } from '@/lib/fonts'
import type { ThemePreference } from '@/lib/types'

export function AppearanceSettings({ value, onChange, themeValue = 'system', onThemeChange, disabled }: { value?: string; onChange: (family: string) => void; themeValue?: ThemePreference; onThemeChange: (theme: ThemePreference) => void; disabled: boolean }) {
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
    <div><h1 className="text-xl font-semibold">外观</h1><p className="mt-1 text-xs leading-5 text-muted-foreground">调整整个应用的主题和界面字体。</p></div>
    <section className="space-y-4">
      <h3 className="border-b border-border pb-2 text-[13px] font-semibold">主题</h3>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
        <Label htmlFor="app-theme" className="pt-2 text-xs text-muted-foreground">界面主题</Label>
        <div className="min-w-0 space-y-2">
          <Select value={themeValue} onValueChange={theme => onThemeChange(theme as ThemePreference)} disabled={disabled} motion>
            <SelectTrigger id="app-theme" aria-label="界面主题" aria-describedby="app-theme-help" className="w-full min-w-0"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
            </SelectContent>
          </Select>
          <p id="app-theme-help" className="text-[11px] leading-5 text-muted-foreground">点击「保存更改」后应用于整个应用，下次启动继续使用。「跟随系统」会随操作系统的深浅色设置自动切换。</p>
        </div>
      </div>
    </section>
    <section className="space-y-4">
      <h3 className="border-b border-border pb-2 text-[13px] font-semibold">字体</h3>
      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
        <Label htmlFor="app-font" className="pt-2 text-xs text-muted-foreground">界面字体</Label>
        <div className="min-w-0 space-y-2">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild><Button id="app-font" variant="outline" role="combobox" aria-label="界面字体" aria-expanded={open} disabled={disabled} className="w-full justify-between gap-2 font-normal"><span className="truncate">{selected || '应用默认（Inter / 系统字体）'}</span><ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" /></Button></PopoverTrigger>
            <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
              <Command><CommandInput placeholder="搜索字体…" aria-label="搜索字体" /><CommandList className="max-h-[min(300px,var(--radix-popover-content-available-height))]" aria-label="可用字体">
                <CommandEmpty>没有匹配的字体</CommandEmpty>
                <CommandItem value="应用默认 Inter 系统字体" onSelect={() => select('')}><Check className={'size-3.5 ' + (selected ? 'opacity-0' : '')} />应用默认（Inter / 系统字体）</CommandItem>
                {options.map(family => <CommandItem key={family} value={family} onSelect={() => select(family)}><Check className={'size-3.5 ' + (selected === family ? '' : 'opacity-0')} /><span className="truncate">{family}</span></CommandItem>)}
              </CommandList></Command>
            </PopoverContent>
          </Popover>
          <p className="text-[11px] leading-5 text-muted-foreground">保存后应用于工作台、聊天和设置页，下次启动继续使用。代码与执行日志保留等宽字体；缺失的字形自动使用系统字体。</p>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span role="status">{loading ? '正在读取字体…' : isDesktop ? `本机可用字体 · ${families.length} 款` : '浏览器预览提供常用字体；桌面应用显示本机字体。'}</span><Button variant="ghost" size="sm" disabled={loading || disabled} onClick={() => setRevision(current => current + 1)}><RefreshCw className="size-3.5" />刷新</Button></div>
          {error && <p role="alert" className="text-xs text-destructive">无法读取本机字体：{error}。可点击刷新重试，或选择应用默认。</p>}
          {!loading && !error && isDesktop && selected && !families.includes(selected) && <p role="status" className="text-xs text-muted-foreground">本机未找到已选字体，将使用默认字体回退。</p>}
        </div>
      </div>
    </section>
    <section className="space-y-3"><h3 className="text-[13px] font-semibold">预览</h3><div data-testid="font-preview" className="space-y-2 rounded-md border border-border bg-surface-inset p-4" style={{ fontFamily: uiFontStack(selected) }}><p className="text-sm">让每个 Agent 专注于目标，让协作清晰可见。</p><p className="text-sm">The quick brown fox jumps over the lazy dog.</p><p className="text-xs text-muted-foreground">Runtime · 模型 · 任务 · 0123456789</p></div><p className="text-[11px] text-muted-foreground">选择字体只更新此处预览，点击「保存更改」后全局生效。</p></section>
  </div>
}
