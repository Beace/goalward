import type { ReactNode } from 'react'
import { Plus, Settings2, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RuntimeLogo } from './RuntimeLogo'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { getReasoningOptions, reasoningLabel, validateReasoning } from '@/lib/reasoning'
import type { Member, ReasoningEffort, Run, Settings, Task } from '@/lib/types'
import { useI18n } from '@/i18n'

interface Props {
  task: Task
  settings: Settings
  selectedRun?: Run
  historic: boolean
  running: boolean
  memberId: string
  onSelectMember: (id: string) => void
  onPatchMember: (id: string, patch: Partial<Member>) => void
  onHandoff: (member: Member, runtimeId: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onSettings: () => void
  action?: ReactNode
}

/** Member configuration belongs beside the next instruction, separate from its recipient. */
export function MemberConfiguration({ task, settings, selectedRun, historic, running, memberId, onSelectMember, onPatchMember, onHandoff, onAdd, onRemove, onSettings, action }: Props) {
  const { t } = useI18n()
  const effortLabel = (value: unknown) => value === undefined ? t('未记录', 'Not recorded') : typeof value === 'string' ? reasoningLabel(value as ReasoningEffort) : t('配置无效', 'Invalid configuration')
  const members = historic ? selectedRun?.members ?? [] : task.mode === 'solo' ? task.members.slice(0, 1) : task.members
  const member = members.find(item => item.id === memberId) ?? members[0]
  if (!member) return null
  const snapshot = selectedRun?.members.find(item => item.id === member.id)
  const runtime = historic ? snapshot?.runtime : settings.runtimes.find(item => item.id === member.runtimeId)
  const runtimes = historic ? [...new Map((selectedRun?.members ?? []).map(item => [item.runtime.id, item.runtime])).values()] : settings.runtimes.filter(item => item.enabled)
  const models = historic ? [] : settings.models.filter(item => item.enabled && item.runtimeIds.includes(member.runtimeId))
  const model = models.find(item => item.modelId === (member.modelId || runtime?.defaultModel))
  const modelDefault = model?.reasoningEffort === undefined ? 'inherit' : model.reasoningEffort
  const nextEffort = member.reasoningEffort === undefined ? modelDefault : member.reasoningEffort
  const error = !historic && runtime ? validateReasoning(runtime, model, nextEffort) : undefined
  const pending = running && snapshot && (member.runtimeId !== snapshot.runtimeId || member.modelId !== snapshot.modelId || member.reasoningEffort !== snapshot.reasoningEffort || (snapshot.effectiveReasoningEffort !== undefined && nextEffort !== snapshot.effectiveReasoningEffort))

  return <div className="member-configuration" aria-label={historic ? t('历史成员配置', 'Historical member configuration') : t('下次执行配置', 'Next run configuration')}>
    {(task.mode === 'team' || members.length > 1) && <div className="configuration-member-row">
      <span>{t('配置成员', 'Configure member')}</span>
      <Select value={member.id} onValueChange={onSelectMember}><SelectTrigger aria-label={t('配置成员', 'Configure member')} className="configuration-member-select"><Users size={12} /><SelectValue /></SelectTrigger><SelectContent>{members.map(item => <SelectItem key={item.id} value={item.id}>{item.role} · {historic ? selectedRun?.members.find(saved => saved.id === item.id)?.runtime.name : settings.runtimes.find(saved => saved.id === item.runtimeId)?.name ?? item.name}</SelectItem>)}</SelectContent></Select>
      <span className="configuration-count">{t(`${members.length} 位成员 · 各自配置`, `${members.length} members · Individually configured`)}</span>
      {!historic && <><Button variant="ghost" size="icon-sm" className="configuration-add-member" aria-label={t('添加成员', 'Add member')} title={running ? t('停止执行后添加成员', 'Stop the run before adding a member') : t(`添加成员（最多 ${settings.maxParallel} 位）`, `Add member (up to ${settings.maxParallel})`)} disabled={running || task.members.length >= settings.maxParallel} onClick={onAdd}><Plus size={14} /></Button><Button variant="ghost" size="icon-sm" aria-label={`${t('移除', 'Remove')} ${member.role}`} title={t('移除配置中的成员', 'Remove member from configuration')} disabled={running || task.members.findIndex(item => item.id === member.id) === 0} onClick={() => onRemove(member.id)}><Trash2 size={13} /></Button></>}
    </div>}
    <div className="configuration-controls">
      <div className="configuration-runtime"><Select value={member.runtimeId} disabled={historic} onValueChange={id => { if (id !== member.runtimeId) onHandoff(member, id) }}><SelectTrigger aria-label={`${member.role} Runtime`} title="Runtime" className="configuration-select"><SelectValue /></SelectTrigger><SelectContent>{!runtimes.some(item => item.id === member.runtimeId) && <SelectItem value={member.runtimeId}>{runtime?.name ?? member.runtimeId} · {t('已禁用', 'Disabled')}</SelectItem>}{runtimes.map(item => <SelectItem value={item.id} key={item.id} textValue={item.name}><span className="inline-flex items-center gap-1.5"><RuntimeLogo runtime={item} size={14} /><span>{item.name}</span></span></SelectItem>)}</SelectContent></Select></div>
      <div className="configuration-model"><Select value={member.modelId || '__default'} disabled={historic} onValueChange={id => onPatchMember(member.id, { modelId: id === '__default' ? '' : id, reasoningEffort: undefined })}><SelectTrigger aria-label={`${member.role} ${t('模型', 'Model')}`} title={t('模型', 'Model')} className="configuration-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">{t('Runtime 默认模型', 'Runtime default model')}</SelectItem>{member.modelId && !models.some(item => item.modelId === member.modelId) && <SelectItem value={member.modelId}>{member.modelId}{!historic && ` · ${t('已有配置', 'Existing configuration')}`}</SelectItem>}{models.map(item => <SelectItem key={item.id} value={item.modelId}>{item.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="configuration-effort"><ReasoningEffortSelect label={`${member.role} ${t('思考强度', 'Reasoning effort')}`} compact className="configuration-select" value={member.reasoningEffort} options={getReasoningOptions(runtime, model)} allowModelDefault={!historic} modelDefaultLabel={`${t('模型默认', 'Model default')} · ${effortLabel(modelDefault)}`} disabled={historic} snapshotLabel={historic ? effortLabel(snapshot?.effectiveReasoningEffort) : undefined} onChange={value => onPatchMember(member.id, { reasoningEffort: value as ReasoningEffort | undefined })} /></div>
      {!historic && <Button className="configuration-settings" variant="ghost" size="icon-sm" aria-label={t('Runtime 与访问权限', 'Runtime and access permissions')} title={t('Runtime 与访问权限', 'Runtime and access permissions')} onClick={onSettings}><Settings2 size={13} /></Button>}
      {action && <div className="configuration-action">{action}</div>}
    </div>
    {running && snapshot && <p className={'configuration-note ' + (pending ? 'pending-config' : '')}>{t('本次：', 'Current run: ')}{snapshot.runtime.name} / {snapshot.model || snapshot.modelId || t('Runtime 默认模型', 'Runtime default model')} / {t('本次思考：', 'Reasoning: ')}{effortLabel(snapshot.effectiveReasoningEffort)}{t('。', '. ')}{pending ? t('新配置下次执行生效', 'New configuration takes effect on the next run') : t('控件用于下一次执行', 'Controls apply to the next run')}</p>}
    {running && !snapshot && <p className="configuration-note">{t('此成员未参与当前批次；更改用于下一次执行。', 'This member is not in the current run; changes apply to the next run.')}</p>}
    {historic && <p className="configuration-note">{t('本次思考：', 'Reasoning: ')}{effortLabel(snapshot?.effectiveReasoningEffort)} · {t('历史配置只读', 'Historical configuration is read-only')}</p>}
    {error && <p role="alert" className="configuration-note configuration-error">{error}</p>}
    {!historic && runtime?.adapter === 'kimi' && !model && <p className="configuration-note">{t('选择已检测的 Kimi 模型后可设置其支持的思考强度；默认模型继续继承 Runtime 配置。', 'Select a detected Kimi model to set its supported reasoning effort; the default model continues to inherit the runtime configuration.')}</p>}
    {!historic && runtime?.adapter === 'codex' && nextEffort === 'ultra' && <p className="configuration-note">{t('ultra 可由 Codex 自动委派子任务。', 'At ultra effort, Codex may delegate subtasks automatically.')}</p>}
  </div>
}
