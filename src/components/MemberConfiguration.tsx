import type { ReactNode } from 'react'
import { Plus, Settings2, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RuntimeLogo } from './RuntimeLogo'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { getReasoningOptions, reasoningLabel, validateReasoning } from '@/lib/reasoning'
import type { Member, ReasoningEffort, Run, Settings, Task } from '@/lib/types'

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

const effortLabel = (value: unknown) => value === undefined ? '未记录' : typeof value === 'string' ? reasoningLabel(value as ReasoningEffort) : '配置无效'

/** Member configuration belongs beside the next instruction, separate from its recipient. */
export function MemberConfiguration({ task, settings, selectedRun, historic, running, memberId, onSelectMember, onPatchMember, onHandoff, onAdd, onRemove, onSettings, action }: Props) {
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

  return <div className="member-configuration" aria-label={historic ? '历史成员配置' : '下次执行配置'}>
    {(task.mode === 'team' || members.length > 1) && <div className="configuration-member-row">
      <span>配置成员</span>
      <Select value={member.id} onValueChange={onSelectMember}><SelectTrigger aria-label="配置成员" className="configuration-member-select"><Users size={12} /><SelectValue /></SelectTrigger><SelectContent>{members.map(item => <SelectItem key={item.id} value={item.id}>{item.role} · {historic ? selectedRun?.members.find(saved => saved.id === item.id)?.runtime.name : settings.runtimes.find(saved => saved.id === item.runtimeId)?.name ?? item.name}</SelectItem>)}</SelectContent></Select>
      <span className="configuration-count">{members.length} 位成员 · 各自配置</span>
      {!historic && <><Button variant="ghost" size="icon-sm" aria-label="添加成员" title={running ? '停止执行后添加成员' : `添加成员（最多 ${settings.maxParallel} 位）`} disabled={running || task.members.length >= settings.maxParallel} onClick={onAdd}><Plus size={14} /></Button><Button variant="ghost" size="icon-sm" aria-label={`移除${member.role}`} title="移除配置中的成员" disabled={running || task.members.findIndex(item => item.id === member.id) === 0} onClick={() => onRemove(member.id)}><Trash2 size={13} /></Button></>}
    </div>}
    <div className="configuration-controls">
      <div className="configuration-runtime"><Select value={member.runtimeId} disabled={historic} onValueChange={id => { if (id !== member.runtimeId) onHandoff(member, id) }}><SelectTrigger aria-label={`${member.role} Runtime`} title="Runtime" className="configuration-select"><SelectValue /></SelectTrigger><SelectContent>{!runtimes.some(item => item.id === member.runtimeId) && <SelectItem value={member.runtimeId}>{runtime?.name ?? member.runtimeId} · 已禁用</SelectItem>}{runtimes.map(item => <SelectItem value={item.id} key={item.id} textValue={item.name}><span className="inline-flex items-center gap-1.5"><RuntimeLogo runtime={item} size={14} /><span>{item.name}</span></span></SelectItem>)}</SelectContent></Select></div>
      <div className="configuration-model"><Select value={member.modelId || '__default'} disabled={historic} onValueChange={id => onPatchMember(member.id, { modelId: id === '__default' ? '' : id, reasoningEffort: undefined })}><SelectTrigger aria-label={`${member.role} 模型`} title="模型" className="configuration-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">Runtime 默认模型</SelectItem>{member.modelId && !models.some(item => item.modelId === member.modelId) && <SelectItem value={member.modelId}>{member.modelId}{!historic && ' · 已有配置'}</SelectItem>}{models.map(item => <SelectItem key={item.id} value={item.modelId}>{item.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="configuration-effort"><ReasoningEffortSelect label={`${member.role} 思考强度`} compact className="configuration-select" value={member.reasoningEffort} options={getReasoningOptions(runtime, model)} allowModelDefault={!historic} modelDefaultLabel={'模型默认 · ' + effortLabel(modelDefault)} disabled={historic} snapshotLabel={historic ? effortLabel(snapshot?.effectiveReasoningEffort) : undefined} onChange={value => onPatchMember(member.id, { reasoningEffort: value as ReasoningEffort | undefined })} /></div>
      {!historic && <Button className="configuration-settings" variant="ghost" size="icon-sm" aria-label="Runtime 与访问权限" title="Runtime 与访问权限" onClick={onSettings}><Settings2 size={13} /></Button>}
      {action && <div className="configuration-action">{action}</div>}
    </div>
    {running && snapshot && <p className={'configuration-note ' + (pending ? 'pending-config' : '')}>本次：{snapshot.runtime.name} / {snapshot.model || snapshot.modelId || 'Runtime 默认模型'} / 本次思考：{effortLabel(snapshot.effectiveReasoningEffort)}。{pending ? '新配置下次执行生效' : '控件用于下一次执行'}</p>}
    {running && !snapshot && <p className="configuration-note">此成员未参与当前批次；更改用于下一次执行。</p>}
    {historic && <p className="configuration-note">本次思考：{effortLabel(snapshot?.effectiveReasoningEffort)} · 历史配置只读</p>}
    {error && <p role="alert" className="configuration-note configuration-error">{error}</p>}
    {!historic && runtime?.adapter === 'kimi' && !model && <p className="configuration-note">选择已检测的 Kimi 模型后可设置其支持的思考强度；默认模型继续继承 Runtime 配置。</p>}
    {!historic && runtime?.adapter === 'codex' && nextEffort === 'ultra' && <p className="configuration-note">ultra 可由 Codex 自动委派子任务。</p>}
  </div>
}
