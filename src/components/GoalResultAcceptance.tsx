import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

export function GoalResultAcceptance({ taskTitle, summary, items, busy, onAccept, onReopen }: {
  taskTitle: string
  summary: string
  items: string[]
  busy: boolean
  onAccept: (checked: string[], note: string) => Promise<void>
  onReopen: (note: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [checked, setChecked] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)
  const disabled = busy || acting

  function toggle(item: string, on: boolean) {
    setChecked(current => on ? [...new Set([...current, item])] : current.filter(entry => entry !== item))
    setError('')
  }

  function reject(message: string) {
    setError(message)
  }

  async function run(action: () => Promise<void>) {
    if (disabled) return
    setActing(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setActing(false) }
  }

  return <section className="goal-result-acceptance" aria-label={t('当前任务验收', 'Current task acceptance')}>
    <h2>{t('当前任务验收要求', 'Acceptance for this task')}</h2>
    <p className="goal-meta">{taskTitle}</p>
    <p className="goal-result-summary">{summary}</p>
    <div className="goal-result-checks">
      {items.map(item => {
        const id = `accept-${item}`
        return <Label key={item} className="goal-result-check" htmlFor={id}>
          <Checkbox id={id} checked={checked.includes(item)} disabled={disabled} onCheckedChange={value => toggle(item, value === true)} />
          <span>{item}</span>
        </Label>
      })}
    </div>
    <Textarea aria-label={t('验收说明', 'Acceptance note')} rows={2} value={note} placeholder={t('可选补充；退回时需要写明要改什么', 'Optional note. Required when you send the result back.')} onChange={event => { setNote(event.target.value); setError('') }} />
    {error && <p className="goal-form-error" role="alert">{error}</p>}
    <div className="goal-result-actions">
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => {
        if (!note.trim()) { reject(t('退回时请写上需要补充的内容。', 'Add a note describing what to revise.')); return }
        void run(() => onReopen(note.trim()))
      }}>{t('退回补充', 'Send back')}</Button>
      <Button type="button" size="sm" disabled={disabled} onClick={() => {
        if (checked.length !== items.length) { reject(t('先勾选全部验收条件。', 'Check every acceptance item first.')); return }
        void run(() => onAccept(checked, [note.trim(), ...checked].filter(Boolean).join('\n')))
      }}>{t('验收通过', 'Accept')}</Button>
    </div>
  </section>
}
