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
import { getCurrentLanguage, translate, useI18n } from '@/i18n'
import './agents.css'

interface Props {
  state: AppState
  onChange: (reducer: (state: AppState) => AppState) => Promise<void>
  onCreateTask: (agentId: string, goalId?: string) => void
  onOpenTask: (taskId: string, runId?: string, memberId?: string) => void
  onSettings: (runtimeId?: string) => void
  initialAgentId?: string
}
const timestamp = (value: string) => new Date(value).toLocaleString(getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
function permissionSummary(runtime?: RuntimeConfig) {
  if (!runtime) return translate('Runtime 未登记，请前往设置。', 'Runtime is not registered. Open Settings.')
  if (runtime.adapter === 'codex') {
    const config = runtime.permissions?.codex
    return config ? `${translate('文件访问', 'File access')}: ${config.sandbox} · ${translate('网络', 'Network')}: ${config.network} · ${translate('额外目录', 'Additional directories')} ${config.additionalDirectories.length}` : translate('继承本机 Codex 权限配置。', 'Inherits local Codex permissions.')
  }
  if (runtime.adapter === 'claude') {
    const config = runtime.permissions?.claude
    return config ? `${translate('权限模式', 'Permission mode')}: ${config.mode} · ${translate('额外目录', 'Additional directories')} ${config.additionalDirectories.length} · ${translate('允许 / 禁止规则', 'Allow / deny rules')} ${config.allowedTools.length} / ${config.disallowedTools.length}` : translate('继承本机 Claude Code 权限配置。', 'Inherits local Claude Code permissions.')
  }
  return translate('权限由 Runtime 配置与适配器控制；请在 Runtime 设置中查看。', 'Permissions are controlled by the runtime and adapter. See Runtime Settings.')
}

export function AgentsPage({ state, onChange, onCreateTask, onOpenTask, onSettings, initialAgentId }: Props) {
  const { t } = useI18n()
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
  const [newRole, setNewRole] = useState(() => translate('执行', 'Execution'))
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
    const success = await commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? updateAgentProfile(item, draft, current.settings) : item) })), t('档案已保存；已有任务与执行记录保持原配置。', 'Profile saved. Existing tasks and runs keep their settings.'))
    if (success) setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next })
  }
  const create = async () => {
    let addedId = ''
    const success = await commit(() => onChange(current => { const profile = createAgentProfile(current.settings, { name: newName, role: newRole, runtimeId: newRuntime, instructions: newInstructions }); addedId = profile.id; return { ...current, agents: [...current.agents, profile] } }), t('Agent 已创建。', 'Agent created.'))
    if (success) { setSelectedId(addedId); setCreating(false); setTab('config'); setNewName(''); setNewRole(t('执行', 'Execution')); setNewInstructions('') }
  }

  return <section className="agents-page" aria-label={t('Agent 管理', 'Agent management')}>
    <aside className="agents-master">
      <header className="agents-master-heading"><div><h1>Agents</h1><span>{visible.length} / {state.agents.length} {t('个档案', 'profiles')}</span></div>
        <Dialog open={creating} onOpenChange={open => { setCreating(open); setError('') }}><DialogTrigger asChild><Button ref={newAgentTrigger} size="icon-sm" variant="outline" aria-label={t('新建 Agent', 'New Agent')}><Plus size={15} /></Button></DialogTrigger>
          <DialogContent className="agents-dialog" onCloseAutoFocus={() => newAgentTrigger.current?.focus()}><DialogHeader><DialogTitle>{t('新建 Agent', 'New Agent')}</DialogTitle><DialogDescription>{t('保存职责与默认配置，供目标和任务重复使用。', 'Save a role and defaults to reuse across goals and tasks.')}</DialogDescription></DialogHeader>
            <form id="create-agent-form" onSubmit={event => { event.preventDefault(); void create() }} className="agents-form-grid">
              <div className="agents-full"><Label htmlFor="new-agent-name">{t('名称', 'Name')}</Label><Input id="new-agent-name" value={newName} maxLength={80} onChange={event => setNewName(event.target.value)} placeholder={t('例如：实现工程师', 'For example: implementation engineer')} autoFocus required /></div>
              <div><Label htmlFor="new-agent-role">{t('职责', 'Role')}</Label><Input id="new-agent-role" value={newRole} maxLength={80} onChange={event => setNewRole(event.target.value)} required /></div>
              <div><Label htmlFor="new-agent-runtime">{t('默认 Runtime', 'Default runtime')}</Label><Select value={newRuntime} onValueChange={setNewRuntime}><SelectTrigger id="new-agent-runtime"><SelectValue /></SelectTrigger><SelectContent>{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{!item.enabled && ` · ${t('已禁用', 'Disabled')}`}</SelectItem>)}</SelectContent></Select></div>
              <div className="agents-full"><Label htmlFor="new-agent-instructions">{t('职责指令', 'Role instructions')}</Label><Textarea id="new-agent-instructions" value={newInstructions} onChange={event => setNewInstructions(event.target.value)} rows={4} placeholder={t('描述工作方式、范围和交付要求，可稍后补充。', 'Describe how this Agent works, its scope, and deliverables. You can add this later.')} /></div>
              {error && <p className="agents-full agents-error" role="alert">{error}</p>}
            </form><DialogFooter><Button variant="outline" onClick={() => setCreating(false)}>{t('取消', 'Cancel')}</Button><Button type="submit" form="create-agent-form" disabled={busy || !newName.trim() || !newRole.trim() || !newRuntime}>{busy ? t('保存中…', 'Saving…') : t('创建 Agent', 'Create Agent')}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </header>
      <div className="agents-search"><Search size={14} /><Input aria-label={t('搜索 Agent', 'Search Agents')} placeholder={t('搜索名称、职责…', 'Search name or role…')} value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="agents-filters"><Select value={runtimeFilter} onValueChange={setRuntimeFilter}><SelectTrigger aria-label={t('筛选 Runtime', 'Filter by runtime')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('全部 Runtime', 'All runtimes')}</SelectItem>{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><Select value={enabledFilter} onValueChange={setEnabledFilter}><SelectTrigger aria-label={t('筛选 Agent 状态', 'Filter by Agent status')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('全部状态', 'All statuses')}</SelectItem><SelectItem value="enabled">{t('已启用', 'Enabled')}</SelectItem><SelectItem value="disabled">{t('已停用', 'Disabled')}</SelectItem></SelectContent></Select></div>
      <div className="agents-list" aria-label={t('Agent 档案列表', 'Agent profile list')}>{visible.map(profile => { const runtimeConfig = state.settings.runtimes.find(item => item.id === profile.runtimeId); const runs = agentActivity(profile.id, state.tasks); return <Button key={profile.id} variant="ghost" className="agents-list-item" aria-label={`${t('选择 Agent', 'Select Agent')} ${profile.name}`} aria-pressed={profile.id === selected?.id} onClick={() => { setSelectedId(profile.id); setError(''); setNotice('') }}>
        <span className="agents-list-top"><strong>{profile.name}{drafts[profile.id] && <span className="agents-unsaved"> *</span>}</strong><Badge variant="outline">{profile.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</Badge></span><span className="agents-list-role">{profile.role}</span><span className="agents-list-runtime"><RuntimeLogo runtime={runtimeConfig} runtimeId={profile.runtimeId} size={14} /><span>{runtimeConfig?.name ?? profile.runtimeId} / {profile.modelId || t('默认模型', 'Default model')}</span></span><span className="agents-list-meta"><span>{profile.assignedGoalIds.filter(goalId => state.goals.some(goal => goal.id === goalId)).length} {t('个目标', 'goals')}</span><span>{runs.active.length} {t('个活动执行', 'active runs')}</span><span>v{profile.version}</span></span>
      </Button> })}{!visible.length && <div className="agents-list-empty"><p>{state.agents.length ? t('没有匹配的 Agent。', 'No matching Agents.') : t('还没有 Agent 档案。', 'No Agent profiles yet.')}</p>{state.agents.length > 0 && <Button variant="link" size="sm" onClick={() => { setSearch(''); setRuntimeFilter('all'); setEnabledFilter('all') }}>{t('清除搜索与筛选', 'Clear search and filters')}</Button>}</div>}</div>
      <footer className="agents-master-footer"><Bot size={13} /><span>{t('档案可复用 · 对话按任务隔离', 'Reusable profiles · Conversations stay within each task')}</span></footer>
    </aside>
    {selected && draft && activity ? <main className="agents-detail">
      <header className="agents-detail-heading"><div className="agents-detail-title"><RuntimeLogo runtimeId={selected.runtimeId} runtime={state.settings.runtimes.find(item => item.id === selected.runtimeId)} size={24} /><div><h2>{selected.name}<Badge variant="outline">v{selected.version}</Badge></h2><p>{selected.role} · {activity.active.length} {t('个活动执行', 'active runs')} · {activity.tasks.length} {t('个任务', 'tasks')}</p></div></div>
        <div className="agents-detail-actions"><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(async () => { const copy = duplicateAgentProfile(selected); await onChange(current => ({ ...current, agents: [...current.agents, copy] })); setSelectedId(copy.id); setTab('config') }, t('已复制为独立档案。', 'Duplicated as an independent profile.'))}><Copy size={13} />{t('复制', 'Duplicate')}</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? { ...item, enabled: !item.enabled, updatedAt: new Date().toISOString() } : item) })), selected.enabled ? t('已停用；已有任务和运行继续保留。', 'Disabled. Existing tasks and runs remain.') : t('已启用，可用于新分配。', 'Enabled for new assignments.'))}>{selected.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}</Button>
          <Dialog open={tasking} onOpenChange={open => { setTasking(open); if (open) setTaskGoalId('__independent') }}><DialogTrigger asChild><Button size="sm" disabled={!selected.enabled}><Plus size={14} />{t('创建任务', 'Create task')}</Button></DialogTrigger><DialogContent className="agents-dialog"><DialogHeader><DialogTitle>{t('用', 'Create task with')} {selected.name} {t('创建任务', '')}</DialogTitle><DialogDescription>{t('使用已保存的', 'Using saved')} v{selected.version} {t('配置。', 'configuration.')} {dirty ? t('当前未保存的修改不会用于新任务。', 'Unsaved changes will not be used for the new task.') : t('任务内可以继续调整配置。', 'You can adjust the configuration in the task.')}</DialogDescription></DialogHeader><Label htmlFor="agent-task-goal">{t('目标归属', 'Goal')}</Label><Select value={taskGoalId} onValueChange={setTaskGoalId}><SelectTrigger id="agent-task-goal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__independent">{t('独立任务', 'Independent task')}</SelectItem>{state.goals.map(goal => <SelectItem key={goal.id} value={goal.id}>{goal.title}</SelectItem>)}</SelectContent></Select><DialogFooter><Button variant="outline" onClick={() => setTasking(false)}>{t('取消', 'Cancel')}</Button><Button onClick={() => { setTasking(false); onCreateTask(selected.id, taskGoalId === '__independent' ? undefined : taskGoalId) }}>{t('继续配置任务', 'Continue configuring task')}<ArrowUpRight size={14} /></Button></DialogFooter></DialogContent></Dialog>
        </div>
      </header>
      {!selected.enabled && <p className="agents-banner">{t('此档案已停用，无法新增任务或目标分配。已有任务与执行不受影响，可移除原有目标关联。', 'This profile is disabled, so it cannot be assigned to new tasks or goals. Existing tasks and runs are unaffected; goal links can be removed.')}</p>}
      <Tabs className="agents-tabs" value={tab} onValueChange={setTab}><div className="agents-tab-bar"><TabsList><TabsTrigger value="config">{t('配置', 'Configuration')}</TabsTrigger><TabsTrigger value="goals">{t('参与目标', 'Goals')} <span>{selected.assignedGoalIds.filter(goalId => state.goals.some(goal => goal.id === goalId)).length}</span></TabsTrigger><TabsTrigger value="tasks">{t('参与任务', 'Tasks')} <span>{activity.tasks.length}</span></TabsTrigger><TabsTrigger value="history">{t('执行与版本', 'Runs and versions')}</TabsTrigger></TabsList></div>
        <TabsContent className="agents-content" value="config"><form id="agent-edit-form" onSubmit={event => { event.preventDefault(); void save() }} className="agents-form-grid">
          <div><Label htmlFor="agent-name">{t('名称', 'Name')}</Label><Input id="agent-name" value={draft.name} maxLength={80} onChange={event => patch({ name: event.target.value })} /></div><div><Label htmlFor="agent-role">{t('职责', 'Role')}</Label><Input id="agent-role" value={draft.role} onChange={event => patch({ role: event.target.value })} placeholder={t('例如：实现 / 测试 / 研究', 'For example: implementation / testing / research')} /></div>
          <div className="agents-full"><Label htmlFor="agent-instructions">{t('职责指令', 'Role instructions')}</Label><Textarea id="agent-instructions" value={draft.instructions} rows={5} onChange={event => patch({ instructions: event.target.value })} placeholder={t('每次执行时随任务上下文发送给此 Agent。', 'Sent to this Agent with task context on each run.')} /><p className="agents-help">{t('用于新成员和明确应用新版的成员；历史执行保留当时指令。', 'Applies to new members and members explicitly updated to this version; past runs retain their instructions.')}</p></div>
          <div><Label htmlFor="agent-runtime">{t('默认 Runtime', 'Default runtime')}</Label><Select value={draft.runtimeId} onValueChange={runtimeId => patch({ runtimeId, modelId: '', reasoningEffort: undefined })}><SelectTrigger id="agent-runtime"><RuntimeLogo runtime={runtime} runtimeId={draft.runtimeId} size={15} /><SelectValue /></SelectTrigger><SelectContent>{!state.settings.runtimes.some(item => item.id === draft.runtimeId) && <SelectItem value={draft.runtimeId || '__missing'} disabled>{draft.runtimeId || t('未选择', 'Not selected')} · {t('未登记', 'Not registered')}</SelectItem>}{state.settings.runtimes.map(item => <SelectItem key={item.id} value={item.id}>{item.name}{!item.enabled && ` · ${t('已禁用', 'Disabled')}`}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="agent-model">{t('默认模型', 'Default model')}</Label><Select value={draft.modelId || '__default'} onValueChange={value => patch({ modelId: value === '__default' ? '' : value, reasoningEffort: undefined })}><SelectTrigger id="agent-model"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__default">{t('继承 Runtime 默认模型', 'Inherit runtime default model')}</SelectItem>{draft.modelId && !models.some(item => item.modelId === draft.modelId) && <SelectItem value={draft.modelId}>{draft.modelId} · {t('已保存配置', 'Saved setting')}</SelectItem>}{models.map(item => <SelectItem value={item.modelId} key={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><p className="agents-help">{t('模型目录为配置记录，调用可用性以执行结果为准。', 'The model catalog records settings; availability is confirmed by actual runs.')}</p></div>
          <div><Label htmlFor="agent-effort">{t('思考强度', 'Reasoning effort')}</Label><ReasoningEffortSelect id="agent-effort" label={t('Agent 默认思考强度', 'Agent default reasoning effort')} value={draft.reasoningEffort} options={getReasoningOptions(runtime, model)} allowModelDefault onChange={value => patch({ reasoningEffort: value as ReasoningEffort | undefined })} /></div><div className="agents-help agents-form-note">{t('任务成员可以单独覆盖，修改档案不会自动替换成员配置。', 'Task members can override this. Editing the profile does not automatically replace member settings.')}</div>
          <div className="agents-full"><Label htmlFor="agent-description">{t('说明', 'Description')}</Label><Textarea id="agent-description" value={draft.description} rows={2} onChange={event => patch({ description: event.target.value })} placeholder={t('使用场景、协作约定或其他说明。', 'Use cases, collaboration conventions, or other notes.')} /></div>
          <section className="agents-capabilities agents-full"><div><h3>{t('权限与能力', 'Permissions and capabilities')}</h3><Button type="button" variant="link" size="sm" onClick={() => onSettings(draft.runtimeId)}><Settings2 size={13} />{t('Runtime 设置', 'Runtime Settings')}</Button></div><p>{permissionSummary(runtime)}</p><dl><div><dt>{t('Runtime 配置', 'Runtime configuration')}</dt><dd>{runtime ? runtime.enabled ? t('已启用 · 不代表模型可调用', 'Enabled · Model availability not verified') : t('已禁用 · 执行前需启用', 'Disabled · Enable before running') : t('未登记', 'Not registered')}</dd></div><div><dt>{t('本机程序检测', 'Local executable scan')}</dt><dd>{(() => { const result = state.onboarding?.lastScan?.runtimes.find(item => item.id === draft.runtimeId); return result ? `${result.probe.found ? t('上次已检测到', 'Found in last scan') : t('上次未检测到', 'Not found in last scan')} · ${timestamp(state.onboarding!.lastScan!.scannedAt)}` : t('未取得检测结果', 'No scan result') })()}</dd></div><div><dt>{t('技能与工具清单', 'Skills and tools')}</dt><dd>{t('未读取 · 以 Runtime 实际公开能力为准', 'Not read · Based on capabilities exposed by the runtime')}</dd></div></dl></section>
        </form></TabsContent>
        <TabsContent className="agents-content" value="goals"><div className="agents-section-heading"><div><h3>{t('参与目标', 'Goals')}</h3><p>{t('关联表示参与职责，任务成员仍按每项任务选择。', 'A goal link indicates involvement; task members are chosen for each task.')}</p></div><Dialog open={assigning} onOpenChange={open => { setAssigning(open); if (open) { setGoalIds([...selected.assignedGoalIds]); setError('') } }}><DialogTrigger asChild><Button variant="outline" size="sm"><Target size={13} />{t('管理目标关联', 'Manage goal links')}</Button></DialogTrigger><DialogContent className="agents-dialog"><DialogHeader><DialogTitle>{t('分配', 'Assign')} {selected.name}</DialogTitle><DialogDescription>{t('选择此 Agent 参与的目标，不会自动创建或启动任务。', 'Choose the goals this Agent participates in. This will not create or start tasks.')}{!selected.enabled && t(' 当前已停用，只能移除原有关联。', ' This profile is disabled; you can only remove existing links.')}</DialogDescription></DialogHeader><div className="agents-assignment-list">{state.goals.map(goal => <label key={goal.id}><Checkbox disabled={!selected.enabled && !selected.assignedGoalIds.includes(goal.id)} checked={goalIds.includes(goal.id)} onCheckedChange={checked => setGoalIds(current => checked ? [...current, goal.id] : current.filter(item => item !== goal.id))} /><span>{goal.title}</span></label>)}{!state.goals.length && <p className="agents-help">{t('还没有目标，可先从目标工作台创建。', 'No goals yet. Create one from the Goals workspace.')}</p>}</div>{error && <p className="agents-error" role="alert">{error}</p>}<DialogFooter><Button variant="outline" onClick={() => setAssigning(false)}>{t('取消', 'Cancel')}</Button><Button disabled={busy} onClick={() => void commit(() => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === selected.id ? { ...item, assignedGoalIds: [...new Set(goalIds)], updatedAt: new Date().toISOString() } : item) })), t('目标关联已更新。', 'Goal links updated.')).then(ok => { if (ok) setAssigning(false) })}>{t('保存关联', 'Save links')}</Button></DialogFooter></DialogContent></Dialog></div>
          {state.goals.filter(goal => selected.assignedGoalIds.includes(goal.id)).map(goal => <article className="agents-associated-row" key={goal.id}><Target size={16} /><div><strong>{goal.title}</strong><p>{activity.tasks.filter(task => task.goalId === goal.id).length} {t('个关联任务', 'linked tasks')}</p></div><Button size="sm" variant="ghost" disabled={!selected.enabled} onClick={() => onCreateTask(selected.id, goal.id)}>{t('创建任务', 'Create task')}<ArrowUpRight size={13} /></Button></article>)}{!state.goals.some(goal => selected.assignedGoalIds.includes(goal.id)) && <div className="agents-empty-inline"><Target size={22} /><p>{t('尚未参与目标', 'No linked goals')}</p><span>{t('可以先创建独立任务，再将成果关联到目标。', 'You can start with an independent task and link its results to a goal later.')}</span></div>}
        </TabsContent>
        <TabsContent className="agents-content" value="tasks"><div className="agents-section-heading"><div><h3>{t('参与任务', 'Tasks')}</h3><p>{t('包括当前成员和历史执行中使用过此档案的任务。', 'Includes tasks using this profile in current membership or past runs.')}</p></div></div>{activity.tasks.map(task => <article className="agents-associated-row" key={task.id}><Users size={16} /><div><strong>{task.title}</strong><p>{state.goals.find(goal => goal.id === task.goalId)?.title ?? t('独立任务', 'Independent task')} · {activity.executions.filter(entry => entry.task.id === task.id).length} {t('次成员执行', 'member runs')}</p></div><Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id)}>{t('打开任务', 'Open task')}<ArrowUpRight size={13} /></Button></article>)}{!activity.tasks.length && <div className="agents-empty-inline"><Users size={22} /><p>{t('还没有参与任务', 'No tasks yet')}</p><span>{t('用已保存的 Agent 档案创建第一个任务。', 'Create your first task with this saved Agent profile.')}</span></div>}</TabsContent>
        <TabsContent className="agents-content" value="history"><div className="agents-section-heading"><div><h3>{t('执行记录', 'Run history')}</h3><p>{t('只展示实际关联到此档案的成员执行；示例任务不计入。', 'Shows only member runs linked to this profile; sample tasks are excluded.')}</p></div></div>{activity.executions.map(({ task, run, member }) => <article className="agents-associated-row" key={`${run.id}:${member.id}`}><RuntimeLogo runtime={member.runtime} size={18} /><div><strong>{task.title}</strong><p>{member.runtime.name} / {member.model || t('Runtime 默认模型', 'Runtime default model')} · {t('档案', 'Profile')} v{member.agentProfileVersion ?? '—'} · {timestamp(run.createdAt)}</p></div><Status status={member.status} /><Button variant="ghost" size="sm" onClick={() => onOpenTask(task.id, run.id, member.id)}>{t('查看 Trace', 'View trace')}<ArrowUpRight size={13} /></Button></article>)}{!activity.executions.length && <p className="agents-empty-note">{t('暂无执行记录。档案启用不代表进程运行。', 'No runs yet. Enabling a profile does not start a process.')}</p>}
          <div className="agents-section-heading agents-version-heading"><div><h3><History size={14} />{t('档案版本', 'Profile versions')}</h3><p>{t('新成员使用保存版；已有任务通过“应用新版”更新继承字段。', 'New members use the saved version. Existing tasks can update inherited fields with “Apply new version.”')}</p></div></div>{[...selected.history].reverse().map(revision => <article className="agents-version-row" key={revision.version}><Badge variant="outline">v{revision.version}</Badge><div><strong>{revision.summary}</strong><p>{revision.snapshot.name} · {state.settings.runtimes.find(item => item.id === revision.snapshot.runtimeId)?.name ?? revision.snapshot.runtimeId} / {revision.snapshot.modelId || t('默认模型', 'Default model')} / {revision.snapshot.reasoningEffort ? reasoningLabel(revision.snapshot.reasoningEffort) : t('模型默认', 'Model default')}</p></div><time>{timestamp(revision.createdAt)}</time></article>)}
        </TabsContent>
      </Tabs>
      <footer className="agents-detail-footer"><div aria-live="polite">{error && !creating && !assigning ? <span className="agents-error" role="alert">{error}</span> : validation && dirty ? <span className="agents-error">{validation}</span> : notice ? <span className="agents-save-notice"><Check size={13} />{notice}</span> : <span>{dirty ? t('有未保存的修改', 'Unsaved changes') : `${t('已保存', 'Saved')} v${selected.version}`} · {t('历史执行保留快照', 'Past runs retain snapshots')}</span>}</div>{tab === 'config' && <><Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => { setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next }); setError(''); setNotice(t('已还原为保存版。', 'Restored to the saved version.')) }}>{t('还原', 'Revert')}</Button><Button type="submit" form="agent-edit-form" size="sm" disabled={!dirty || busy || Boolean(validation)}>{busy ? t('保存中…', 'Saving…') : t('保存新版本', 'Save new version')}</Button></>}</footer>
    </main> : <main className="agents-empty"><Bot size={30} /><h2>{t('把协作方式保存为 Agent', 'Save your workflow as an Agent')}</h2><p>{t('配置职责、Runtime 与默认模型，从任意目标或独立任务中复用。', 'Set its role, runtime, and default model, then reuse it in goals or independent tasks.')}</p><Button onClick={() => setCreating(true)}><Plus size={14} />{t('新建第一个 Agent', 'Create your first Agent')}</Button></main>}
  </section>
}
