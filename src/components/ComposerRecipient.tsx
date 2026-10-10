import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { RuntimeLogo } from './RuntimeLogo'
import { getReasoningOptions, reasoningLabel, validateReasoning } from '@/lib/reasoning'
import type { Member, ReasoningEffort, Run, Settings, Task } from '@/lib/types'
import { useI18n } from '@/i18n'

interface Props {
  task: Task; settings: Settings; selectedRun?: Run; historic: boolean; running: boolean
  recipient: string; onRecipient: (id: string) => void
  onPatch: (id: string, patch: Partial<Member>) => void
  onManage: () => void; onSettings: () => void
}

/** Explicit recipient selection; browsing conversations and managing members remain independent. */
export function ComposerRecipient({ task, settings, selectedRun, historic, running, recipient, onRecipient, onPatch, onManage, onSettings }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const members = historic ? selectedRun?.members ?? [] : task.mode === 'solo' ? task.members.slice(0, 1) : task.members
  const all = recipient === 'all' && task.mode === 'team'
  const member = members.find(item => item.id === recipient) ?? members[0]
  const snapshot = selectedRun?.members.find(item => item.id === member?.id)
  const runtime = historic ? snapshot?.runtime : settings.runtimes.find(item => item.id === member?.runtimeId)
  const runtimes = settings.runtimes.filter(item => item.enabled)
  const models = historic ? [] : settings.models.filter(item => item.enabled && item.runtimeIds.includes(member?.runtimeId ?? ''))
  const currentModel = models.find(item => item.modelId === (member?.modelId || runtime?.defaultModel))
  const effort = member?.reasoningEffort === undefined ? currentModel?.reasoningEffort ?? 'inherit' : member.reasoningEffort
  const error = !historic && runtime ? validateReasoning(runtime, currentModel, effort) : undefined
  const label = all ? t(`所有成员 · ${members.length} 人`, `All members · ${members.length}`) : member ? `${member.role} · ${runtime?.name ?? member.name}` : t('未配置成员', 'No member configured')
  const choices = [{ id: '', name: t('Runtime 默认模型', 'Runtime default model'), model: models.find(item => item.modelId === runtime?.defaultModel) }, ...models.map(model => ({ id: model.modelId, name: model.name, model }))]
  if (member?.modelId && !models.some(item => item.modelId === member.modelId)) choices.push({ id: member.modelId, name: historic ? snapshot?.model || member.modelId : `${member.modelId} · ${t('已有配置', 'Existing configuration')}`, model: undefined })
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="ghost" size="sm" className="composer-recipient-trigger" aria-label={t(`消息接收者：${label}`, `Message recipient: ${label}`)}><span>{t('发给：', 'To:')}</span><span className="composer-recipient-label">{label}</span><ChevronDown size={12} /></Button></PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} collisionPadding={12} className="composer-recipient-menu" aria-label={t('接收者与模型配置', 'Recipient and model configuration')}>
        <div className="recipient-columns">
          <div className="recipient-members" aria-label={t('发送目标', 'Send to')}>
            <p className="recipient-menu-label">{t('发给', 'To')}{historic ? ` · ${t('历史只读', 'Historical, read-only')}` : ''}</p>
            {members.map(item => <Button key={item.id} variant="ghost" className="recipient-member" aria-pressed={!all && member?.id === item.id} disabled={historic} onClick={() => onRecipient(item.id)}><span>{item.role}</span><ChevronRight size={12} /></Button>)}
            {task.mode === 'team' && <Button variant="ghost" className="recipient-member" aria-pressed={all} disabled={historic} onClick={() => onRecipient('all')}><span>{t('所有成员', 'All members')}</span>{all && <Check size={12} />}</Button>}
            {!all && <div className="recipient-runtime-section">
              <p className="recipient-menu-label">Runtime</p>
              <div className="recipient-runtime-picker">
                <Select motion value={member?.runtimeId ?? ''} disabled={historic || !member} onValueChange={id => {
                  const next = runtimes.find(item => item.id === id)
                  if (historic || !member || !next || id === member.runtimeId) return
                  onPatch(member.id, { runtimeId: next.id, name: next.name, modelId: next.defaultModel, reasoningEffort: undefined })
                }}>
                  <SelectTrigger className="recipient-runtime-trigger" aria-label={`${member?.role ?? t('成员', 'Member')} Runtime`} title={t('选择 Runtime', 'Select runtime')}>
                    <SelectValue placeholder={t('选择 Runtime', 'Select runtime')}><span className="recipient-runtime-value"><RuntimeLogo runtime={runtime} size={14} /><span>{runtime?.name ?? member?.runtimeId ?? t('未配置 Runtime', 'No runtime configured')}{!historic && runtime && !runtime.enabled ? ` · ${t('已禁用', 'Disabled')}` : ''}</span></span></SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {member?.runtimeId && !runtimes.some(item => item.id === member.runtimeId) && <SelectItem value={member.runtimeId} disabled>{runtime?.name ?? member.runtimeId} · {t('不可用', 'Unavailable')}</SelectItem>}
                    {runtimes.map(item => <SelectItem key={item.id} value={item.id} textValue={item.name}><span className="inline-flex items-center gap-1.5"><RuntimeLogo runtime={item} size={14} /><span>{item.name}</span></span></SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>}
          </div>
          <div className="recipient-models" aria-label={t('成员模型配置', 'Member model configuration')}>
            {all && <p className="recipient-menu-label"><Users size={13} />{t('所有成员', 'All members')}</p>}
            {all ? <div className="recipient-all-summary"><p>{t('分别使用各自配置并行执行', 'Run in parallel using each member’s configuration')}</p>{members.map(item => <p key={item.id}><strong>{item.role}</strong><span>{item.modelId || t('Runtime 默认模型', 'Runtime default model')}</span></p>)}</div> : member ? <div className="recipient-model-list">{choices.map(choice => {
              const selected = (member.modelId || '') === choice.id
              return <div key={choice.id} className="recipient-model-row" data-selected={selected}>
                <Button variant="ghost" className="recipient-model-choice" aria-label={`${t('选择模型', 'Select model')} ${choice.name}`} aria-pressed={selected} disabled={historic} onClick={() => { if (!selected) onPatch(member.id, { modelId: choice.id, reasoningEffort: undefined }) }}><span>{choice.name}</span>{selected && <Check size={13} />}</Button>
                <ReasoningEffortSelect motion side="right" label={`${member.role} · ${choice.name} ${t('思考强度', 'Reasoning effort')}`} compact className="recipient-effort" value={selected ? member.reasoningEffort : undefined} options={getReasoningOptions(runtime, choice.model)} allowModelDefault={!historic} modelDefaultLabel={`${t('模型默认', 'Model default')} · ${reasoningLabel(choice.model?.reasoningEffort ?? 'inherit')}`} disabled={historic} snapshotLabel={historic ? snapshot?.effectiveReasoningEffort ? reasoningLabel(snapshot.effectiveReasoningEffort) : t('未记录', 'Not recorded') : undefined} onChange={value => onPatch(member.id, { modelId: choice.id, reasoningEffort: value as ReasoningEffort | undefined })} />
              </div>
            })}</div> : <p className="recipient-note">{t('请先添加一个成员。', 'Add a member first.')}</p>}
            {running && <p className="recipient-note">{t('配置更改下次执行生效', 'Configuration changes take effect on the next run')}{snapshot && !all ? t(`；本次：${snapshot.runtime.name} / ${snapshot.model || snapshot.modelId || 'Runtime 默认模型'} / ${snapshot.effectiveReasoningEffort ? reasoningLabel(snapshot.effectiveReasoningEffort) : '思考强度未记录'}`, `; current run: ${snapshot.runtime.name} / ${snapshot.model || snapshot.modelId || 'Runtime default model'} / ${snapshot.effectiveReasoningEffort ? reasoningLabel(snapshot.effectiveReasoningEffort) : 'Reasoning effort not recorded'}`) : ''}</p>}
            {historic && <p className="recipient-note">{t('历史配置只读', 'Historical configuration is read-only')}</p>}
            {!all && error && <p className="recipient-note configuration-error" role="alert">{error}</p>}
          </div>
        </div>
        <div className="recipient-menu-footer"><Button variant="ghost" onClick={() => { setOpen(false); onManage() }}>{t('成员与 Runtime', 'Members and runtimes')}<Users size={13} /></Button><Button variant="ghost" onClick={() => { setOpen(false); onSettings() }}>{t('模型设置', 'Model settings')}<ArrowRight size={13} /></Button></div>
      </PopoverContent>
    </Popover>
    {!all && error && !open && <p className="recipient-inline-error" role="alert">{error}</p>}
  </>
}
