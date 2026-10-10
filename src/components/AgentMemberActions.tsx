import { useState } from 'react'
import { Bot, Plus, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { agentFromMember, memberFromAgent, updateMemberFromAgent } from '@/lib/agent-profiles'
import type { AppState, Task } from '@/lib/types'
import './agents.css'
import { useI18n } from '@/i18n'

interface Props {
  task: Task
  state: AppState
  memberId: string
  onChange: (reducer: (state: AppState) => AppState) => Promise<void>
  onOpenAgent?: (id: string) => void
}

/** Profile commands change the next task configuration, never any Run snapshot. */
export function AgentMemberActions({ task, state, memberId, onChange, onOpenAgent }: Props) {
  const { t } = useI18n()
  const member = task.members.find(item => item.id === memberId) ?? task.members[0]
  const profile = state.agents.find(item => item.id === member?.agentProfileId)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const running = task.runs.some(run => run.members.some(entry => entry.status === 'running'))
  const enabled = state.agents.filter(item => item.enabled)
  const commit = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setFeedback('')
    try { await action(); setFeedback(success); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false } finally { setBusy(false) }
  }
  return <div className="agent-member-actions" aria-label={t('成员档案管理', 'Member profile management')}>
    {profile ? <><Button variant="ghost" size="sm" disabled={!onOpenAgent} onClick={() => onOpenAgent?.(profile.id)}><Bot size={12} />{profile.name} · v{member?.agentProfileVersion ?? '—'}</Button>{profile.version !== member?.agentProfileVersion && <Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(() => onChange(current => {
      const latest = current.agents.find(item => item.id === profile.id)
      if (!latest) throw new Error(t('Agent 档案已不存在。', 'Agent profile no longer exists.'))
      return { ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, members: item.members.map(entry => entry.id === member?.id ? updateMemberFromAgent(entry, latest).member : entry) } : item) }
    }), t(`已应用 v${profile.version}，保留任务内覆盖${running ? '；下次执行生效' : ''}。`, `Applied v${profile.version}, preserving task overrides${running ? '; effective next run' : ''}.`))}><RefreshCw size={12} />{t('应用', 'Apply')} v{profile.version}</Button>}</> : member && <span>{t('临时成员', 'Temporary member')}</span>}
    {member && <Dialog open={saving} onOpenChange={open => { setSaving(open); if (open) { setName(member.name); setError('') } }}><DialogTrigger asChild><Button variant="ghost" size="sm"><Save size={12} />{t('保存为 Agent', 'Save as Agent')}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{t('保存成员为 Agent', 'Save member as Agent')}</DialogTitle><DialogDescription>{t('保存当前成员配置为独立档案，并关联此成员。已有执行快照不变。', 'Save the current member configuration as a separate profile and link it to this member. Existing run snapshots stay unchanged.')}</DialogDescription></DialogHeader><form id="save-member-agent" onSubmit={event => { event.preventDefault(); void commit(() => onChange(current => {
      const currentTask = current.tasks.find(item => item.id === task.id)
      const currentMember = currentTask?.members.find(item => item.id === member.id)
      if (!currentMember) throw new Error(t('此任务成员已不存在。', 'This task member no longer exists.'))
      const next = agentFromMember(currentMember, current.settings, name)
      return { ...current, agents: [...current.agents, next], tasks: current.tasks.map(item => item.id === task.id ? { ...item, members: item.members.map(entry => entry.id === member.id ? { ...entry, agentProfileId: next.id, agentProfileVersion: next.version } : entry) } : item) }
    }), t('已保存为 Agent 档案。', 'Saved as an Agent profile.')).then(ok => { if (ok) setSaving(false) }) }}><Label htmlFor="member-agent-name">{t('Agent 名称', 'Agent name')}</Label><Input id="member-agent-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus required /></form>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setSaving(false)}>{t('取消', 'Cancel')}</Button><Button form="save-member-agent" type="submit" disabled={busy || !name.trim()}>{t('保存档案', 'Save profile')}</Button></DialogFooter></DialogContent></Dialog>}
    <Dialog open={adding} onOpenChange={open => { setAdding(open); if (open) { setChoice(enabled[0]?.id ?? ''); setError('') } }}><DialogTrigger asChild><Button variant="ghost" size="sm" disabled={running || !enabled.length || task.members.length >= state.settings.maxParallel} title={running ? t('执行结束后可添加成员', 'Add a member after the run ends') : t('从已启用的 Agent 档案添加成员', 'Add a member from an enabled Agent profile')}><Plus size={12} />{t('添加已有 Agent', 'Add existing Agent')}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{t('添加任务成员', 'Add task member')}</DialogTitle><DialogDescription>{t('复制已保存的 Agent 配置。成员可在此任务单独调整。', 'Copy a saved Agent configuration. You can adjust the member for this task separately.')}</DialogDescription></DialogHeader><Select value={choice} onValueChange={setChoice}><SelectTrigger aria-label={t('选择已有 Agent', 'Select existing Agent')}><SelectValue /></SelectTrigger><SelectContent>{enabled.map(item => <SelectItem key={item.id} value={item.id}>{item.name} · v{item.version}</SelectItem>)}</SelectContent></Select>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setAdding(false)}>{t('取消', 'Cancel')}</Button><Button disabled={busy || !choice} onClick={() => void commit(() => onChange(current => {
      const next = current.agents.find(item => item.id === choice)
      if (!next) throw new Error(t('Agent 档案已不存在。', 'Agent profile no longer exists.'))
      const currentTask = current.tasks.find(item => item.id === task.id)
      if (!currentTask) throw new Error(t('任务已不存在。', 'Task no longer exists.'))
      if (currentTask.runs.some(run => run.members.some(entry => entry.status === 'running'))) throw new Error(t('请等待当前执行结束后再添加成员。', 'Wait for the current run to end before adding a member.'))
      if (currentTask.members.length >= current.settings.maxParallel) throw new Error(t('成员数量已达到当前并行上限。', 'Member count has reached the parallel limit.'))
      return { ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, mode: item.members.length ? 'team' : 'solo', members: [...item.members, memberFromAgent(next)] } : item) }
    }), t('已从档案添加任务成员。', 'Task member added from profile.')).then(ok => { if (ok) setAdding(false) })}>{t('添加成员', 'Add member')}</Button></DialogFooter></DialogContent></Dialog>
    {(feedback || error && !saving && !adding) && <p aria-live="polite" className={error ? 'agents-error' : ''}>{error || feedback}</p>}
  </div>
}
