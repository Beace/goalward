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

interface Props {
  task: Task
  state: AppState
  memberId: string
  onChange: (reducer: (state: AppState) => AppState) => Promise<void>
  onOpenAgent?: (id: string) => void
}

/** Profile commands change the next task configuration, never any Run snapshot. */
export function AgentMemberActions({ task, state, memberId, onChange, onOpenAgent }: Props) {
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
  return <div className="agent-member-actions" aria-label="成员档案管理">
    {profile ? <><Button variant="ghost" size="sm" disabled={!onOpenAgent} onClick={() => onOpenAgent?.(profile.id)}><Bot size={12} />{profile.name} · v{member?.agentProfileVersion ?? '—'}</Button>{profile.version !== member?.agentProfileVersion && <Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(() => onChange(current => {
      const latest = current.agents.find(item => item.id === profile.id)
      if (!latest) throw new Error('Agent 档案已不存在。')
      return { ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, members: item.members.map(entry => entry.id === member?.id ? updateMemberFromAgent(entry, latest).member : entry) } : item) }
    }), `已应用 v${profile.version}，保留任务内覆盖${running ? '；下次执行生效' : ''}。`)}><RefreshCw size={12} />应用 v{profile.version}</Button>}</> : member && <span>临时成员</span>}
    {member && <Dialog open={saving} onOpenChange={open => { setSaving(open); if (open) { setName(member.name); setError('') } }}><DialogTrigger asChild><Button variant="ghost" size="sm"><Save size={12} />保存为 Agent</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>保存成员为 Agent</DialogTitle><DialogDescription>保存当前成员配置为独立档案，并关联此成员。已有执行快照不变。</DialogDescription></DialogHeader><form id="save-member-agent" onSubmit={event => { event.preventDefault(); void commit(() => onChange(current => {
      const currentTask = current.tasks.find(item => item.id === task.id)
      const currentMember = currentTask?.members.find(item => item.id === member.id)
      if (!currentMember) throw new Error('此任务成员已不存在。')
      const next = agentFromMember(currentMember, current.settings, name)
      return { ...current, agents: [...current.agents, next], tasks: current.tasks.map(item => item.id === task.id ? { ...item, members: item.members.map(entry => entry.id === member.id ? { ...entry, agentProfileId: next.id, agentProfileVersion: next.version } : entry) } : item) }
    }), '已保存为 Agent 档案。').then(ok => { if (ok) setSaving(false) }) }}><Label htmlFor="member-agent-name">Agent 名称</Label><Input id="member-agent-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus required /></form>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setSaving(false)}>取消</Button><Button form="save-member-agent" type="submit" disabled={busy || !name.trim()}>保存档案</Button></DialogFooter></DialogContent></Dialog>}
    <Dialog open={adding} onOpenChange={open => { setAdding(open); if (open) { setChoice(enabled[0]?.id ?? ''); setError('') } }}><DialogTrigger asChild><Button variant="ghost" size="sm" disabled={running || !enabled.length || task.members.length >= state.settings.maxParallel} title={running ? '执行结束后可添加成员' : '从已启用的 Agent 档案添加成员'}><Plus size={12} />添加已有 Agent</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>添加任务成员</DialogTitle><DialogDescription>复制已保存的 Agent 配置。成员可在此任务单独调整。</DialogDescription></DialogHeader><Select value={choice} onValueChange={setChoice}><SelectTrigger aria-label="选择已有 Agent"><SelectValue /></SelectTrigger><SelectContent>{enabled.map(item => <SelectItem key={item.id} value={item.id}>{item.name} · v{item.version}</SelectItem>)}</SelectContent></Select>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setAdding(false)}>取消</Button><Button disabled={busy || !choice} onClick={() => void commit(() => onChange(current => {
      const next = current.agents.find(item => item.id === choice)
      if (!next) throw new Error('Agent 档案已不存在。')
      const currentTask = current.tasks.find(item => item.id === task.id)
      if (!currentTask) throw new Error('任务已不存在。')
      if (currentTask.runs.some(run => run.members.some(entry => entry.status === 'running'))) throw new Error('请等待当前执行结束后再添加成员。')
      if (currentTask.members.length >= current.settings.maxParallel) throw new Error('成员数量已达到当前并行上限。')
      return { ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, mode: item.members.length ? 'team' : 'solo', members: [...item.members, memberFromAgent(next)] } : item) }
    }), '已从档案添加任务成员。').then(ok => { if (ok) setAdding(false) })}>添加成员</Button></DialogFooter></DialogContent></Dialog>
    {(feedback || error && !saving && !adding) && <p aria-live="polite" className={error ? 'agents-error' : ''}>{error || feedback}</p>}
  </div>
}
