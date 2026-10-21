import { useState, type FormEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { discoveredRuntimeNames, firstRunTemplates } from '@/lib/first-run'
import type { LocalDiscoveryReport } from '@/lib/types'
import { useI18n } from '@/i18n'
import './first-run.css'

export interface FirstRunDiscovery {
  report: LocalDiscoveryReport | null
  scanning: boolean
  error: string
  onScan: () => void
  onImport: (runtimeIds: string[], defaultRuntimeId: string) => Promise<unknown>
  onDefer: () => Promise<unknown>
}

export function FirstRunEntry({ value, onValueChange, onSubmit, onCreateManually, discovery, onInspect }: {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => Promise<void>
  onCreateManually: () => void
  discovery?: FirstRunDiscovery
  onInspect: () => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const names = discoveredRuntimeNames(discovery?.report)
  const status = discovery?.scanning
    ? t('正在后台检测本机 Runtime', 'Checking local runtimes in the background')
    : discovery?.error
      ? discovery.error
      : names.length
        ? t(`已找到 ${names.join('、')}`, `Found ${names.join(', ')}`)
        : discovery?.report
          ? t('尚未找到可用的本机 Runtime', 'No usable local runtime found yet')
          : t('执行前再选择 Runtime，不阻挡记录目标', 'Choose a runtime when you run, not before you record a goal')

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const idea = value.trim()
    if (!idea || busy) return
    setBusy(true)
    setError('')
    try { await onSubmit(idea) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="first-run-entry">
    <div className="first-run-entry-inner">
      <h1>{t('你想推进什么？', 'What do you want to move forward?')}</h1>
      <p className="first-run-entry-lead">{t('说一句话就行。目标助手会在这个画面里把它变成可核对的目标。', 'One sentence is enough. The goal assistant will turn it into a goal you can check, on this screen.')}</p>
      <form className="first-run-composer" onSubmit={event => void submit(event)}>
        <Textarea
          autoFocus
          aria-label={t('你想推进什么？', 'What do you want to move forward?')}
          placeholder={t('例如：两周内让新用户 10 分钟跑通首个任务', 'For example: get a new user through the first task in 10 minutes')}
          value={value}
          rows={4}
          onChange={event => onValueChange(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="first-run-composer-bar">
          <span>{t('⌘ Enter 或 Ctrl Enter 发送，Enter 换行', 'Press Command+Enter or Control+Enter to send; Enter adds a line')}</span>
          <Button type="submit" size="icon" aria-label={t('开始整理目标', 'Start clarifying goal')} disabled={busy || !value.trim()}>{busy ? <Spinner className="size-4" aria-hidden="true" role="presentation" aria-label={undefined} /> : <ArrowUp size={16} />}</Button>
        </div>
      </form>
      {error && <p className="goal-form-error" role="alert">{error}</p>}
      <fieldset className="first-run-chips">
        <legend className="sr-only">{t('例子', 'Examples')}</legend>
        {firstRunTemplates.map(template => {
          const label = t(template.label[0], template.label[1])
          const prompt = t(template.prompt[0], template.prompt[1])
          return <Button key={template.id} type="button" variant="outline" size="sm" aria-pressed={value.trim() === prompt} onClick={() => onValueChange(prompt)}>{label}</Button>
        })}
      </fieldset>
      <p className="first-run-status" role="status">
        {discovery?.scanning && <Spinner className="size-3.5" aria-hidden="true" role="presentation" aria-label={undefined} />}
        <span>{status}</span>
        <Button type="button" variant="link" size="sm" onClick={onInspect}>{t('查看', 'View')}</Button>
      </p>
      <div className="first-run-manual">
        <Button type="button" variant="ghost" size="sm" onClick={onCreateManually}>{t('创建第一个目标', 'Create your first goal')}</Button>
      </div>
    </div>
  </div>
}
