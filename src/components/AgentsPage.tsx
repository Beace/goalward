import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Bot, Check, Copy, History, Plus, Search, Settings2, Target, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { agentActivity, agentConfig, createAgentProfile, duplicateAgentProfile, updateAgentProfile, validateAgentProfile } from '@/lib/agent-profiles'
import { getReasoningOptions, reasoningLabel } from '@/lib/reasoning'
import { RuntimeLogo } from './RuntimeLogo'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { Status } from './Status'
import type { AppState, ReasoningEffort, RuntimeConfig } from '@/lib/types'
import type { AgentProfileConfig } from '@/lib/agent-types'
import './agents.css'

interface Props {
  state: AppState
  onChange: (reducer: (state: AppState) => AppState) => Promise<void>
  onCreateTask: (agentId: string, goalId?: string) => void
  onOpenTask: (taskId: string, runId?: string, memberId?: string) => void
  onSettings: (runtimeId?: string) => void
  initialAgentId?: string
}
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
function permissionSummary(runtime?: RuntimeConfig) {
  if (!runtime) return 'Runtime 未登记，请前往设置。'
  if (runtime.adapter === 'codex') {
    const config = runtime.permissions?.codex
    return config ? `文件访问：${config.sandbox} · 网络：${config.network} · 额外目录 ${config.additionalDirectories.length} 项` : '继承本机 Codex 权限配置。'
  }
  if (runtime.adapter === 'claude') {
    const config = runtime.permissions?.claude
    return config ? `权限模式：${config.mode} · 额外目录 ${config.additionalDirectories.length} 项 · 允许 / 禁止规则 ${config.allowedTools.length} / ${config.disallowedTools.length} 项` : '继承本机 Claude Code 权限配置。'
  }
  return '权限由 Runtime 配置与适配器控制；请在 Runtime 设置中查看。'
}

export function AgentsPage({ state, onChange, onCreateTask, onOpenTask, onSettings, initialAgentId }: Props) {
  const [selectedId, setSelectedId] = useState(initialAgentId ?? state.agents[0]?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, AgentProfileConfig>>({})
  const [search, setSearch] = useState('')
  const [runtimeFilter, setRuntimeFilter] = useState('all')
  const [enabledFilter, setEnabledFilter] = useState('all')
  const [tab, setTab] = useState('config')
  const [creating, setCreating] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [tasking, setTasking] = useState(false)
  const [goalIds, setGoalIds] = useState<string[]>([])
  const [taskGoalId, setTaskGoalId] = useState('__independent')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('执行')
  const [newRuntime, setNewRuntime] = useState(state.settings.defaultRuntime)
  const [newInstructions, setNewInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const newAgentTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (initialAgentId) setSelectedId(initialAgentId) }, [initialAgentId])
  const selected = state.agents.find(item => item.id === selectedId) ?? state.agents[0]
  const draft = selected ? drafts[selected.id] ?? agentConfig(selected) : undefined
  const runtime = state.settings.runtimes.find(item => item.id === draft?.runtimeId)
  const models = state.settings.models.filter(item => item.enabled && item.runtimeIds.includes(draft?.runtimeId ?? ''))
  const model = models.find(item => item.modelId === (draft?.modelId || runtime?.defaultModel))
  const activity = useMemo(() => selected ? agentActivity(selected.id, state.tasks) : undefined, [selected, state.tasks])
  const dirty = selected && draft ? JSON.stringify(draft) !== JSON.stringify(agentConfig(selected)) : false
  const validation = draft ? validateAgentProfile(draft, state.settings) : undefined
  const query = search.trim().toLocaleLowerCase()
  const visible = state.agents.filter(profile => (runtimeFilter === 'all' || profile.runtimeId === runtimeFilter) && (enabledFilter === 'all' || (enabledFilter === 'enabled') === profile.enabled) && (!query || `${profile.name} ${profile.role} ${profile.description}`.toLocaleLowerCase().includes(query)))
  const patch = (values: Partial<AgentProfileConfig>) => { if (selected && draft) { setDrafts(current => ({ ...current, [selected.id]: { ...draft, ...values } })); setError(''); setNotice('') } }
  const commit = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); setNotice(success); return true } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false } finally { setBusy(false) }
  }
  const save = async () => {
    if (!selected || !draft) return
    const success = await commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? updateAgentProfile(item, draft, current.settings) : item) })), '档案已保存；已有任务与执行记录保持原配置。')
    if (success) setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next })
  }
  const create = async () => {
    let addedId = ''
    const success = await commit(() => onChange(current => { const profile = createAgentProfile(current.settings, { name: newName, role: newRole, runtimeId: newRuntime, instructions: newInstructions }); addedId = profile.id; return { ...current, agents: [...current.agents, profile] } }), 'Agent 已创建。')
    if (success) { setSelectedId(addedId); setCreating(false); setTab('config'); setNewName(''); setNewRole('执行'); setNewInstructions('') }
  }

  return <section className="agents-page" aria-label="Agent 管理">
    <aside className="agents-master">
      <header className="agents-master-heading"><div><h1>Agents</h1><span>{visible.length} / {state.agents.length} 个档案</span></div>
        <Dialog open={creating} onOpenChange={open => { setCreating(open); setError('') }}><DialogTrigger asChild><Button ref={newAgentTrigger} size="icon-sm" variant="outline" aria-label="新建 Agent"><Plus size={15} /></Button></DialogTrigger>
          <DialogContent className="agents-dialog" onCloseAutoFocus={() => newAgentTrigger.current?.focus()}><DialogHeader><DialogTitle>新建 Agent</DialogTitle><DialogDescription>保存职责与默认配置，供目标和任务重复使用。</DialogDescription></DialogHeader>
            <form id="create-agent-form" onSubmit={event => { event.preventDefault(); void create() }} className="agents-form-grid">
              <div className="agents-full"><Label htmlFor="new-agent-name">名称</Label><Input id="new-agent-name" value={newName} maxLength={80} onChange={event => setNewName(event.target.value)} placeholder="例如：实现工程师" autoFocus required /></div>
              <div><Label htmlFor="new-agent-role">职责</Label><Input id="new-agent-role" value={newRole} maxLength={80} onChange={event => setNewRole(event.target.value)} required /></div>
              <div><Label htmlFor="new-agent-runtime">默认 Runtime</Label><Select value={newRuntime} onValueChange={setNewRuntime}><SelectTrigger id="new-agent-runtime"><SelectValue /></SelectTrigger><SelectContent>{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{!item.enabled && ' · 已禁用'}</SelectItem>)}</SelectContent></Select></div>
              <div className="agents-full"><Label htmlFor="new-agent-instructions">职责指令</Label><Textarea id="new-agent-instructions" value={newInstructions} onChange={event => setNewInstructions(event.target.value)} rows={4} placeholder="描述工作方式、范围和交付要求，可稍后补充。" /></div>
              {error && <p className="agents-full agents-error" role="alert">{error}</p>}
            </form><DialogFooter><Button variant="outline" onClick={() => setCreating(false)}>取消</Button><Button type="submit" form="create-agent-form" disabled={busy || !newName.trim() || !newRole.trim() || !newRuntime}>{busy ? '保存中…' : '创建 Agent'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </header>
      <div className="agents-search"><Search size={14} /><Input aria-label="搜索 Agent" placeholder="搜索名称、职责…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="agents-filters"><Select value={runtimeFilter} onValueChange={setRuntimeFilter}><SelectTrigger aria-label="筛选 Runtime"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部 Runtime</SelectItem>{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><Select value={enabledFilter} onValueChange={setEnabledFilter}><SelectTrigger aria-label="筛选 Agent 状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="enabled">已启用</SelectItem><SelectItem value="disabled">已停用</SelectItem></SelectContent></Select></div>
      <div className="agents-list" aria-label="Agent 档案列表">{visible.map(profile => { const runtimeConfig = state.settings.runtimes.find(item => item.id === profile.runtimeId); const runs = agentActivity(profile.id, state.tasks); return <Button key={profile.id} variant="ghost" className="agents-list-item" aria-label={`选择 Agent ${profile.name}`} aria-pressed={profile.id === selected?.id} onClick={() => { setSelectedId(profile.id); setError(''); setNotice('') }}>
        <span className="agents-list-top"><strong>{profile.name}{drafts[profile.id] && <span className="agents-unsaved"> *</span>}</strong><Badge variant="outline">{profile.enabled ? '已启用' : '已停用'}</Badge></span><span className="agents-list-role">{profile.role}</span><span className="agents-list-runtime"><RuntimeLogo runtime={runtimeConfig} runtimeId={profile.runtimeId} size={14} /><span>{runtimeConfig?.name ?? profile.runtimeId} / {profile.modelId || '默认模型'}</span></span><span className="agents-list-meta"><span>{profile.assignedGoalIds.filter(goalId => state.goals.some(goal => goal.id === goalId)).length} 个目标</span><span>{runs.active.length} 个活动执行</span><span>v{profile.version}</span></span>
      </Button> })}{!visible.length && <div className="agents-list-empty"><p>{state.agents.length ? '没有匹配的 Agent。' : '还没有 Agent 档案。'}</p>{state.agents.length > 0 && <Button variant="link" size="sm" onClick={() => { setSearch(''); setRuntimeFilter('all'); setEnabledFilter('all') }}>清除搜索与筛选</Button>}</div>}</div>
      <footer className="agents-master-footer"><Bot size={13} /><span>档案可复用 · 对话按任务隔离</span></footer>
    </aside>
    {selected && draft && activity ? <main className="agents-detail">
      <header className="agents-detail-heading"><div className="agents-detail-title"><RuntimeLogo runtimeId={selected.runtimeId} runtime={state.settings.runtimes.find(item => item.id === selected.runtimeId)} size={24} /><div><h2>{selected.name}<Badge variant="outline">v{selected.version}</Badge></h2><p>{selected.role} · {activity.active.length} 个活动执行 · {activity.tasks.length} 个任务</p></div></div>
        <div className="agents-detail-actions"><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(async () => { const copy = duplicateAgentProfile(selected); await onChange(current => ({ ...current, agents: [...current.agents, copy] })); setSelectedId(copy.id); setTab('config') }, '已复制为独立档案。')}><Copy size={13} />复制</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? { ...item, enabled: !item.enabled, updatedAt: new Date().toISOString() } : item) })), selected.enabled ? '已停用；已有任务和运行继续保留。' : '已启用，可用于新分配。')}>{selected.enabled ? '停用' : '启用'}</Button>
          <Dialog open={tasking} onOpenChange={open => { setTasking(open); if (open) setTaskGoalId('__independent') }}><DialogTrigger asChild><Button size="sm" disabled={!selected.enabled}><Plus size={14} />创建任务</Button></DialogTrigger><DialogContent className="agents-dialog"><DialogHeader><DialogTitle>用 {selected.name} 创建任务</DialogTitle><DialogDescription>使用已保存的 v{selected.version} 配置。{dirty ? '当前未保存的修改不会用于新任务。' : '任务内可以继续调整配置。'}</DialogDescription></DialogHeader><Label htmlFor="agent-task-goal">目标归属</Label><Select value={taskGoalId} onValueChange={setTaskGoalId}><SelectTrigger id="agent-task-goal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__independent">独立任务</SelectItem>{state.goals.map(goal => <SelectItem key={goal.id} value={goal.id}>{goal.title}</SelectItem>)}</SelectContent></Select><DialogFooter><Button variant="outline" onClick={() => setTasking(false)}>取消</Button><Button onClick={() => { setTasking(false); onCreateTask(selected.id, taskGoalId === '__independent' ? undefined : taskGoalId) }}>继续配置任务<ArrowUpRight size={14} /></Button></DialogFooter></DialogContent></Dialog>
        </div>
      </header>
      {!selected.enabled && <p className="agents-banner">此档案已停用，无法新增任务或目标分配。已有任务与执行不受影响，可移除原有目标关联。</p>}
      <Tabs className="agents-tabs" value={tab} onValueChange={setTab}><div className="agents-tab-bar"><TabsList><TabsTrigger value="config">配置</TabsTrigger><TabsTrigger value="goals">参与目标 <span>{selected.assignedGoalIds.filter(goalId => state.goals.some(goal => goal.id === goalId)).length}</span></TabsTrigger><TabsTrigger value="tasks">参与任务 <span>{activity.tasks.length}</span></TabsTrigger><TabsTrigger value="history">执行与版本</TabsTrigger></TabsList></div>
        <TabsContent className="agents-content" value="config"><form id="agent-edit-form" onSubmit={event => { event.preventDefault(); void save() }} className="agents-form-grid">
          <div><Label htmlFor="agent-name">名称</Label><Input id="agent-name" value={draft.name} maxLength={80} onChange={event => patch({ name: event.target.value })} /></div><div><Label htmlFor="agent-role">职责</Label><Input id="agent-role" value={draft.role} onChange={event => patch({ role: event.target.value })} placeholder="例如：实现 / 测试 / 研究" /></div>
          <div className="agents-full"><Label htmlFor="agent-instructions">职责指令</Label><Textarea id="agent-instructions" value={draft.instructions} rows={5} onChange={event => patch({ instructions: event.target.value })} placeholder="每次执行时随任务上下文发送给此 Agent。" /><p className="agents-help">用于新成员和明确应用新版的成员；历史执行保留当时指令。</p></div>
          <div><Label htmlFor="agent-runtime">默认 Runtime</Label><Select value={draft.runtimeId} onValueChange={runtimeId => patch({ runtimeId, modelId: '', reasoningEffort: undefined })}><SelectTrigger id="agent-runtime"><RuntimeLogo runtime={runtime} runtimeId={draft.runtimeId} size={15} /><SelectValue /></SelectTrigger><SelectContent>{!state.settings.runtimes.some(item => item.id === draft.runtimeId) && <SelectItem value={draft.runtimeId || '__missing'} disabled>{draft.runtimeId || '未选择'} · 未登记</SelectItem>}{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{!item.enabled && ' · 已禁用'}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="agent-model">默认模型</Label><Select value={draft.modelId || '__default'} onValueChange={value => patch({ modelId: value === '__default' ? '' : value, reasoningEffort: undefined })}><SelectTrigger id="agent-model"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">继承 Runtime 默认模型</SelectItem>{draft.modelId && !models.some(item => item.modelId === draft.modelId) && <SelectItem value={draft.modelId}>{draft.modelId} · 已保存配置</SelectItem>}{models.map(item => <SelectItem value={item.modelId} key={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><p className="agents-help">模型目录为配置记录，调用可用性以执行结果为准。</p></div>
          <div><Label htmlFor="agent-effort">思考强度</Label><ReasoningEffortSelect id="agent-effort" label="Agent 默认思考强度" value={draft.reasoningEffort} options={getReasoningOptions(runtime, model)} allowModelDefault onChange={value => patch({ reasoningEffort: value as ReasoningEffort | undefined })} /></div><div className="agents-help agents-form-note">任务成员可以单独覆盖，修改档案不会自动替换成员配置。</div>
          <div className="agents-full"><Label htmlFor="agent-description">说明</Label><Textarea id="agent-description" value={draft.description} rows={2} onChange={event => patch({ description: event.target.value })} placeholder="使用场景、协作约定或其他说明。" /></div>
          <section className="agents-capabilities agents-full"><div><h3>权限与能力</h3><Button type="button" variant="link" size="sm" onClick={() => onSettings(draft.runtimeId)}><Settings2 size={13} />Runtime 设置</Button></div><p>{permissionSummary(runtime)}</p><dl><div><dt>Runtime 配置</dt><dd>{runtime ? runtime.enabled ? '已启用 · 不代表模型可调用' : '已禁用 · 执行前需启用' : '未登记'}</dd></div><div><dt>本机程序检测</dt><dd>{(() => { const result = state.onboarding?.lastScan?.runtimes.find(item => item.id === draft.runtimeId); return result ? `${result.probe.found ? '上次已检测到' : '上次未检测到'} · ${timestamp(state.onboarding!.lastScan!.scannedAt)}` : '未取得检测结果' })()}</dd></div><div><dt>技能与工具清单</dt><dd>未读取 · 以 Runtime 实际公开能力为准</dd></div></dl></section>
        </form></TabsContent>
        <TabsContent className="agents-content" value="goals"><div className="agents-section-heading"><div><h3>参与目标</h3><p>关联表示参与职责，任务成员仍按每项任务选择。</p></div><Dialog open={assigning} onOpenChange={open => { setAssigning(open); if (open) { setGoalIds([...selected.assignedGoalIds]); setError('') } }}><DialogTrigger asChild><Button variant="outline" size="sm"><Target size={13} />管理目标关联</Button></DialogTrigger><DialogContent className="agents-dialog"><DialogHeader><DialogTitle>分配 {selected.name}</DialogTitle><DialogDescription>选择此 Agent 参与的目标，不会自动创建或启动任务。{!selected.enabled && ' 当前已停用，只能移除原有关联。'}</DialogDescription></DialogHeader><div className="agents-assignment-list">{state.goals.map(goal => <label key={goal.id}><Checkbox disabled={!selected.enabled && !selected.assignedGoalIds.includes(goal.id)} checked={goalIds.includes(goal.id)} onCheckedChange={checked => setGoalIds(current => checked ? [...current, goal.id] : current.filter(item => item !== goal.id))} /><span>{goal.title}</span></label>)}{!state.goals.length && <p className="agents-help">还没有目标，可先从目标工作台创建。</p>}</div>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setAssigning(false)}>取消</Button><Button disabled={busy} onClick={() => void commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? { ...item, assignedGoalIds: [...new Set(goalIds)], updatedAt: new Date().toISOString() } : item) })), '目标关联已更新。').then(ok => { if (ok) setAssigning(false) })}>保存关联</Button></DialogFooter></DialogContent></Dialog></div>
          {state.goals.filter(goal => selected.assignedGoalIds.includes(goal.id)).map(goal => <article className="agents-associated-row" key={goal.id}><Target size={16} /><div><strong>{goal.title}</strong><p>{activity.tasks.filter(task => task.goalId === goal.id).length} 个关联任务</p></div><Button size="sm" variant="ghost" disabled={!selected.enabled} onClick={() => onCreateTask(selected.id, goal.id)}>创建任务<ArrowUpRight size={13} /></Button></article>)}{!state.goals.some(goal => selected.assignedGoalIds.includes(goal.id)) && <div className="agents-empty-inline"><Target size={22} /><p>尚未参与目标</p><span>可以先创建独立任务，再将成果关联到目标。</span></div>}
        </TabsContent>
        <TabsContent className="agents-content" value="tasks"><div className="agents-section-heading"><div><h3>参与任务</h3><p>包括当前成员和历史执行中使用过此档案的任务。</p></div></div>{activity.tasks.map(task => <article className="agents-associated-row" key={task.id}><Users size={16} /><div><strong>{task.title}</strong><p>{state.goals.find(goal => goal.id === task.goalId)?.title ?? '独立任务'} · {activity.executions.filter(entry => entry.task.id === task.id).length} 次成员执行</p></div><Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id)}>打开任务<ArrowUpRight size={13} /></Button></article>)}{!activity.tasks.length && <div className="agents-empty-inline"><Users size={22} /><p>还没有参与任务</p><span>用已保存的 Agent 档案创建第一个任务。</span></div>}</TabsContent>
        <TabsContent className="agents-content" value="history"><div className="agents-section-heading"><div><h3>执行记录</h3><p>只展示实际关联到此档案的成员执行；示例任务不计入。</p></div></div>{activity.executions.map(({ task, run, member }) => <article className="agents-associated-row" key={`${run.id}:${member.id}`}><RuntimeLogo runtime={member.runtime} size={18} /><div><strong>{task.title}</strong><p>{member.runtime.name} / {member.model || 'Runtime 默认模型'} · 档案 v{member.agentProfileVersion ?? '—'} · {timestamp(run.createdAt)}</p></div><Status status={member.status} /><Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id, run.id, member.id)}>查看 Trace<ArrowUpRight size={13} /></Button></article>)}{!activity.executions.length && <p className="agents-empty-note">暂无执行记录。档案启用不代表进程运行。</p>}
          <div className="agents-section-heading agents-version-heading"><div><h3><History size={14} />档案版本</h3><p>新成员使用保存版；已有任务通过“应用新版”更新继承字段。</p></div></div>{[...selected.history].reverse().map(revision => <article className="agents-version-row" key={revision.version}><Badge variant="outline">v{revision.version}</Badge><div><strong>{revision.summary}</strong><p>{revision.snapshot.name} · {state.settings.runtimes.find(item => item.id === revision.snapshot.runtimeId)?.name ?? revision.snapshot.runtimeId} / {revision.snapshot.modelId || '默认模型'} / {revision.snapshot.reasoningEffort ? reasoningLabel(revision.snapshot.reasoningEffort) : '模型默认'}</p></div><time>{timestamp(revision.createdAt)}</time></article>)}
        </TabsContent>
      </Tabs>
      <footer className="agents-detail-footer"><div aria-live="polite">{error && !creating && !assigning ? <span className="agents-error" role="alert">{error}</span> : validation && dirty ? <span className="agents-error">{validation}</span> : notice ? <span className="agents-save-notice"><Check size={13} />{notice}</span> : <span>{dirty ? '有未保存的修改' : `已保存 v${selected.version}`} · 历史执行保留快照</span>}</div>{tab === 'config' && <><Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => { setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next }); setError(''); setNotice('已还原为保存版。') }}>还原</Button><Button type="submit" form="agent-edit-form" size="sm" disabled={!dirty || busy || Boolean(validation)}>{busy ? '保存中…' : '保存新版本'}</Button></>}</footer>
    </main> : <main className="agents-empty"><Bot size={30} /><h2>把协作方式保存为 Agent</h2><p>配置职责、Runtime 与默认模型，从任意目标或独立任务中复用。</p><Button onClick={() => setCreating(true)}><Plus size={14} />新建第一个 Agent</Button></main>}
  </section>
}
