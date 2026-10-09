import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ArrowRight, BookOpen, CalendarClock, Check, Circle, FileCheck2, Flag, History, ListChecks, Pencil, Plus, Search, Target, Users } from 'lucide-react'
import type { AppState, Task } from '@/lib/types'
import type { Goal, GoalCriterion, GoalEntryKind, GoalPlanStage, GoalReview, GoalSource, GoalStateProposal, GoalStatus } from '@/lib/goal-types'
import { acceptGoalProposal, createGoal, createStateEntry, goalEntryLabels, goalStatusLabels, rebaseGoalProposal, reviewJudgementLabels, reviseGoal, saveGoalReview, setGoalStatus, updateCriterion, updateGoalState, validateReviewSchedule } from '@/lib/goals'
import { Button } from '@/components/ui/button'
import { notify } from '@/components/ui/sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RuntimeLogo } from './RuntimeLogo'
import { GoalListLayout } from './GoalListLayout'
import './goals.css'

export interface GoalsPageProps {
  state: AppState
  onChange: (reducer: (state: AppState) => AppState) => Promise<void>
  onCreateTask: (goalId: string, title?: string) => void
  onOpenTask: (taskId: string) => void
  onOpenAgent: (agentId?: string) => void
  selectedGoalId?: string
  onSelectGoal?: (goalId: string) => void
  hideGoalList?: boolean
  goalListWidth?: RefObject<number>
}
type Modal = 'create' | 'edit' | 'state' | 'criterion' | 'plan' | 'review' | 'schedule' | 'proposal' | null
type Draft = Record<string, string>
const lines = (value = '') => value.split('\n').map(line => line.trim()).filter(Boolean)
const now = () => new Date().toISOString()
const when = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const taskLabels: Record<string, string> = { todo: '待开始', in_progress: '进行中', blocked: '受阻', review: '待验收', done: '已完成', cancelled: '已取消' }
const stageLabels: Record<GoalPlanStage['status'], string> = { planned: '待推进', active: '进行中', done: '已完成', blocked: '受阻' }
const criterionLabels: Record<GoalCriterion['status'], string> = { unverified: '待验证', satisfied: '已满足', unsatisfied: '尚未满足' }
const modalTitles: Record<Exclude<Modal, null>, string> = { create: '创建目标', edit: '修订目标与成功条件', state: '更新现状', criterion: '检查成功条件', plan: '编辑推进阶段', review: '记录复盘', schedule: '周期复盘', proposal: '核对现状变化建议' }

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
  return <div className="goal-field"><Label htmlFor={id}>{label}</Label>{children}{hint && <p className="goal-meta">{hint}</p>}</div>
}
function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Record<string, string> }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select>
}
function SectionTitle({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="goal-section-title"><h2>{icon}{title}</h2>{children}</div>
}
function GoalBadge({ status }: { status: GoalStatus }) { return <Badge variant="outline" className={`goal-status goal-status-${status}`}>{goalStatusLabels[status]}</Badge> }

function HistoryDisclosure({ title, children }: { title: string; children: ReactNode }) { return <Collapsible><CollapsibleTrigger className="goal-disclosure"><CollapsibleIndicator size={13} />{title}</CollapsibleTrigger><CollapsibleContent><div className="goal-history-detail">{children}</div></CollapsibleContent></Collapsible> }

export function GoalsPage({ state, onChange, onCreateTask, onOpenTask, onOpenAgent, selectedGoalId, onSelectGoal, hideGoalList, goalListWidth }: GoalsPageProps) {
  const [localId, setLocalId] = useState(state.goals[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('overview')
  const [modal, setModal] = useState<Modal>(null)
  const [modalGoalId, setModalGoalId] = useState('')
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const goal = state.goals.find(item => item.id === (selectedGoalId || localId)) ?? state.goals[0]
  const selectedTasks = goal ? state.tasks.filter(task => task.goalId === goal.id) : []
  const participants = goal ? state.agents.filter(agent => agent.assignedGoalIds.includes(goal.id)) : []
  const modalGoal = state.goals.find(item => item.id === modalGoalId)
  const proposal = modalGoal?.proposals.find(item => item.id === draft.proposalId)
  const chooseGoal = (goalId: string) => { setLocalId(goalId); onSelectGoal?.(goalId); setTab('overview'); setError('') }
  const field = (name: string, value: string) => setDraft(current => ({ ...current, [name]: value }))

  function open(type: Exclude<Modal, null>, values: Draft = {}) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft(values); setModalGoalId(goal?.id ?? ''); setError(''); setModal(type)
  }
  async function persist(reducer: (state: AppState) => AppState, success: string, close = false) {
    setSaving(true); setError('')
    try { await onChange(reducer); notify.success(success); if (close) setModal(null); return true } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); if (modal) setError(message); else notify.error(message); return false } finally { setSaving(false) }
  }
  const changeGoal = (goalId: string, updater: (goal: Goal) => Goal) => (previous: AppState): AppState => {
    if (!previous.goals.some(item => item.id === goalId)) throw new Error('目标已不存在，请刷新后再试。')
    return { ...previous, goals: previous.goals.map(item => item.id === goalId ? updater(item) : item) }
  }
  function editGoal() {
    if (!goal) return
    open('edit', { title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, criteria: goal.criteria.map(item => item.text).join('\n'), reason: '', baseVersion: String(goal.version) })
  }
  function editState(entryId = '') {
    if (!goal) return
    const entry = goal.currentState.entries.find(item => item.id === entryId)
    open('state', { summary: goal.currentState.summary, text: entry?.text ?? '', kind: entry?.kind ?? 'fact', sourceLabel: entry?.source.label ?? '用户提供', sourceKind: entry?.source.kind ?? 'user', reference: entry?.source.reference ?? '', reason: '', entryId, baseVersion: String(goal.currentState.version), metricName: entry?.metric?.name ?? '', metricValue: entry?.metric ? String(entry.metric.value) : '', metricUnit: entry?.metric?.unit ?? '', metricDefinition: entry?.metric?.definition ?? '' })
  }
  function editPlan(stage?: GoalPlanStage) { open('plan', { stageId: stage?.id ?? '', title: stage?.title ?? '', description: stage?.description ?? '', status: stage?.status ?? 'planned' }) }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || !modal) return
    if (modal === 'create') {
      let created: Goal
      try { created = createGoal({ title: draft.title ?? '', intent: draft.intent, expected: draft.expected, currentSummary: draft.summary, criteria: lines(draft.criteria) }) } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); return }
      const saved = await persist(previous => ({ ...previous, goals: [...previous.goals, created] }), '目标已创建，可继续补充现状与任务。', true)
      if (!saved) return
      // Selection is local UI state; creation itself does not require a Runtime.
      setLocalId(created.id); onSelectGoal?.(created.id); setTab('overview')
      return
    }
    if (!modalGoal) { setError('请重新选择目标。'); return }
    await persist(changeGoal(modalGoal.id, current => {
      if (modal === 'edit') {
        if (current.version !== Number(draft.baseVersion)) throw new Error('目标已被修订，请重新打开并核对最新版本。')
        return reviseGoal(current, { title: draft.title ?? '', intent: draft.intent ?? '', expected: draft.expected ?? '', constraints: draft.constraints ?? '', deadline: draft.deadline ?? '', criteria: lines(draft.criteria), reason: draft.reason ?? '' })
      }
      if (modal === 'state') {
        const previousSource = current.currentState.entries.find(item => item.id === draft.entryId)?.source
        const source: GoalSource = { ...(previousSource?.kind === draft.sourceKind ? previousSource : {}), kind: (draft.sourceKind ?? 'user') as GoalSource['kind'], label: draft.sourceLabel?.trim() || '用户提供', reference: draft.reference?.trim() || undefined }
        let entries = current.currentState.entries
        if (draft.text?.trim()) {
          const entry = createStateEntry(draft.kind as GoalEntryKind, draft.text, source)
          if (draft.kind === 'metric') {
            if (!draft.metricName?.trim() || !draft.metricDefinition?.trim() || !draft.metricValue?.trim() || !Number.isFinite(Number(draft.metricValue))) throw new Error('指标观测需要名称、数值和统计口径。')
            entry.metric = { name: draft.metricName.trim(), value: Number(draft.metricValue), unit: draft.metricUnit?.trim() ?? '', definition: draft.metricDefinition.trim(), observedAt: now() }
          }
          if (draft.entryId) entries = entries.map(item => item.id === draft.entryId ? { ...entry, id: item.id } : item)
          else entries = [...entries, entry]
        } else if (draft.entryId) throw new Error('修订现状条目时内容不能为空。')
        return updateGoalState(current, { summary: draft.summary ?? '', entries, reason: draft.reason ?? '', source, baseStateVersion: Number(draft.baseVersion) })
      }
      if (modal === 'criterion') return updateCriterion(current, draft.criterionId, draft.status as GoalCriterion['status'], draft.evidence ?? '')
      if (modal === 'plan') {
        if (!draft.title?.trim()) throw new Error('请填写阶段名称。')
        const stage: GoalPlanStage = { id: draft.stageId || `stage-${crypto.randomUUID()}`, title: draft.title.trim(), description: draft.description?.trim() ?? '', status: draft.status as GoalPlanStage['status'] }
        return { ...current, plan: draft.stageId ? current.plan.map(item => item.id === draft.stageId ? stage : item) : [...current.plan, stage], updatedAt: now() }
      }
      if (modal === 'review') return saveGoalReview(current, { judgement: (draft.judgement ?? 'unknown') as GoalReview['judgement'], summary: draft.summary ?? '', evidence: draft.evidence ?? '', nextActions: lines(draft.actions) })
      if (modal === 'schedule') {
        const enabled = draft.enabled === 'true'
        const reviewSchedule = { enabled, weekday: Number(draft.weekday), hour: Number(draft.hour), timeZone: draft.timeZone ?? '', startedAt: current.reviewSchedule?.enabled ? current.reviewSchedule.startedAt : now() }
        validateReviewSchedule(reviewSchedule)
        return { ...current, reviewSchedule, updatedAt: now() }
      }
      if (modal === 'proposal') {
        const item = current.proposals.find(item => item.id === draft.proposalId)
        if (!item) throw new Error('找不到该建议。')
        return item.baseStateVersion === current.currentState.version ? acceptGoalProposal(current, item.id) : rebaseGoalProposal(current, item.id)
      }
      return current
    }), modal === 'proposal' && proposal?.baseStateVersion !== modalGoal.currentState.version ? '已保留旧建议并生成重新核对的版本，请确认采纳。' : '已保存，历史版本与执行快照保持可追溯。', true)
  }

  function TaskRows({ tasks }: { tasks: Task[] }) {
    return tasks.length ? <div className="goal-task-list">{tasks.map(task => <div className="goal-task-row" key={task.id}><ListChecks size={14} /><div><Button variant="link" className="goal-text-link" onClick={() => onOpenTask(task.id)}>{task.title}</Button><p className="goal-meta">{task.executor === 'human' ? '人工完成' : `${task.members.length} 位成员`}{task.acceptance ? ` · ${task.acceptance}` : ' · 尚未填写验收要求'}</p></div><Badge variant="outline">{taskLabels[task.businessStatus ?? 'todo']}</Badge><Button size="icon-sm" variant="ghost" aria-label={`打开任务：${task.title}`} onClick={() => onOpenTask(task.id)}><ArrowRight size={14} /></Button></div>)}</div> : <p className="goal-empty-copy">还没有关联任务。可以从下一步行动开始，也可以先补充资料。</p>
  }
  function ProposalRows() {
    const pending = goal?.proposals.filter(item => item.status === 'pending') ?? []
    if (!pending.length) return null
    return <section className="goal-section"><SectionTitle icon={<FileCheck2 size={15} />} title="待采纳变化"><Badge variant="outline">{pending.length}</Badge></SectionTitle>{pending.map(item => <div className="goal-proposal" key={item.id}><p>{item.title}</p><p className="goal-meta">{item.source.label} · 基于现状 v{item.baseStateVersion}{item.baseStateVersion !== goal?.currentState.version ? ' · 需要重新核对' : ''}</p><div className="goal-row-actions"><Button variant="ghost" size="sm" disabled={saving} onClick={() => void persist(changeGoal(goal!.id, current => ({ ...current, updatedAt: now(), proposals: current.proposals.map(proposal => proposal.id === item.id ? { ...proposal, status: 'rejected', resolvedAt: now() } : proposal) })), '变化建议已保留为未采纳。')}>不采纳</Button><Button variant="outline" size="sm" onClick={() => open('proposal', { proposalId: item.id })}>核对变化</Button></div></div>)}</section>
  }
  function Source({ source }: { source: GoalSource }) { return <span>{source.label}{source.reference && <> · {source.reference}</>}{source.taskId && (state.tasks.some(task => task.id === source.taskId) ? <> · <Button variant="link" className="goal-inline-link" onClick={() => onOpenTask(source.taskId!)}>查看来源任务</Button></> : <> · 来源任务已删除</>)}</span> }

  return <div className={`goals-page${hideGoalList ? ' goals-without-list' : ''}`}>
    <GoalListLayout rememberedWidth={goalListWidth} navigation={!hideGoalList && <aside className="goal-picker" aria-label="目标列表"><div className="goal-picker-heading"><span><Target size={15} />目标</span><Button size="icon-sm" variant="ghost" aria-label="创建目标" onClick={() => open('create')}><Plus size={16} /></Button></div><div className="goal-search"><Search size={14} /><Input aria-label="搜索目标" placeholder="搜索目标…" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="goal-picker-list">{state.goals.filter(item => `${item.title} ${item.expected}`.toLowerCase().includes(search.toLowerCase())).map(item => <Button key={item.id} variant="ghost" className={`goal-choice${item.id === goal?.id ? ' is-selected' : ''}`} aria-pressed={item.id === goal?.id} onClick={() => chooseGoal(item.id)}><span title={item.title}>{item.title}</span><small>{goalStatusLabels[item.status]} · v{item.version}</small></Button>)}{!state.goals.length && <p className="goal-empty-copy">把想推进的事情记录在这里。</p>}</div><div className="goal-picker-footer">目标与现状持续保存<br />执行按任务组织</div></aside>}>
    {!goal ? <main className="goal-empty"><Target size={30} /><h1>从一个想推进的目标开始</h1><p>描述预期，逐步补充现状、成功条件和下一步行动。<br />创建目标无需配置 Runtime 或工作目录。</p><Button onClick={() => open('create')}><Plus size={15} />创建第一个目标</Button></main> : <main className="goal-detail">
      <header className="goal-header"><div className="goal-heading"><div><p className="goal-meta">目标 / <GoalBadge status={goal.status} /> <span>定义 v{goal.version} · 现状 v{goal.currentState.version}</span></p><h1>{goal.title}</h1><p className="goal-subtitle">{goal.expected || '先记录想做的事，再逐步明确预期结果。'}</p></div><div className="goal-header-actions"><Button variant="outline" onClick={() => editState()}><Pencil size={14} />更新现状</Button><Button onClick={() => onCreateTask(goal.id)}><Plus size={14} />创建任务</Button></div></div></header>
      <Tabs value={tab} onValueChange={setTab} className="goal-tabs"><TabsList variant="line" aria-label="目标内容"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="tasks">任务 <span className="goal-tab-count">{selectedTasks.length}</span></TabsTrigger><TabsTrigger value="history">进展记录</TabsTrigger><TabsTrigger value="reviews">复盘 <span className="goal-tab-count">{goal.reviews.length}</span></TabsTrigger></TabsList>
        <TabsContent value="overview" className="goal-scroll"><div className="goal-columns"><div className="goal-primary-column">
          <section className="goal-section goal-criteria"><SectionTitle icon={<Flag size={15} />} title="预期状态与成功条件"><Button variant="ghost" size="sm" onClick={editGoal}>修订</Button></SectionTitle><p className="goal-desired">{goal.expected || '尚未明确预期状态，点击修订即可补充。'}</p>{goal.criteria.length ? <div className="goal-criterion-list">{goal.criteria.map(criterion => <Button key={criterion.id} variant="ghost" className="goal-criterion" onClick={() => open('criterion', { criterionId: criterion.id, status: criterion.status, evidence: criterion.evidence })}>{criterion.status === 'satisfied' ? <Check size={15} /> : <Circle size={13} />}<span>{criterion.text}</span><small>{criterionLabels[criterion.status]}</small></Button>)}</div> : <p className="goal-empty-copy">成功条件可以是产物、事实、判断或指标，不要求统一的百分比。</p>}</section>
          <ProposalRows />
          <section className="goal-section"><SectionTitle icon={<BookOpen size={15} />} title="当前现状"><span className="goal-meta">v{goal.currentState.version} · {when(goal.currentState.createdAt)}</span></SectionTitle>{goal.currentState.summary && <p className="goal-state-summary">{goal.currentState.summary}</p>}{goal.currentState.entries.length ? goal.currentState.entries.map(entry => <div className={`goal-fact goal-entry-${entry.kind}`} key={entry.id}><span className="goal-entry-kind">{goalEntryLabels[entry.kind]}</span><div><p>{entry.text}</p>{entry.metric && <p className="goal-metric"><strong>{entry.metric.value}{entry.metric.unit}</strong> {entry.metric.name}<span>{entry.metric.definition}</span></p>}<p className="goal-meta"><Source source={entry.source} /> · {when(entry.createdAt)}</p></div><Button size="icon-sm" variant="ghost" aria-label={`修订现状：${entry.text}`} onClick={() => editState(entry.id)}><Pencil size={12} /></Button></div>) : <p className="goal-empty-copy">{goal.currentState.summary ? '可以继续补充事实、成果、未知问题及来源。' : '现状还不明确。可以直接描述，也可以记录资料位置和查询方式。'}</p>}</section>
          <section className="goal-section"><SectionTitle icon={<ListChecks size={15} />} title="推进计划"><Button size="sm" variant="ghost" onClick={() => editPlan()}><Plus size={13} />添加阶段</Button></SectionTitle>{goal.plan.map((stage, index) => <div className="goal-stage" key={stage.id}><span className="goal-stage-index">{String(index + 1).padStart(2, '0')}</span><div><Button className="goal-text-link" variant="link" onClick={() => editPlan(stage)}>{stage.title}</Button><p className="goal-meta">{stage.description || '可补充这一阶段要解决的问题与预期成果。'}</p></div><Badge variant="outline">{stageLabels[stage.status]}</Badge></div>)}{!goal.plan.length && <p className="goal-empty-copy">先写下一步，或添加阶段组织后续任务。</p>}<TaskRows tasks={selectedTasks.slice(0, 5)} />{selectedTasks.length > 5 && <Button size="sm" variant="ghost" onClick={() => setTab('tasks')}>查看全部 {selectedTasks.length} 个任务 <ArrowRight size={13} /></Button>}</section>
        </div><aside className="goal-context-column">
          <section className="goal-section"><SectionTitle icon={<Users size={15} />} title="参与 Agents"><Button variant="ghost" size="sm" onClick={() => onOpenAgent()}>管理</Button></SectionTitle>{participants.length ? participants.map(agent => { const runtime = state.settings.runtimes.find(runtime => runtime.id === agent.runtimeId); const running = state.tasks.flatMap(task => task.runs).flatMap(run => run.members).filter(member => member.agentProfileId === agent.id && member.status === 'running').length; return <Button key={agent.id} variant="ghost" className="goal-agent-row" onClick={() => onOpenAgent(agent.id)}><span><strong>{agent.name}</strong><small>{running ? `${running} 个运行中` : agent.enabled ? '可分配' : '已停用'}</small></span><span className="goal-agent-runtime"><RuntimeLogo runtime={runtime} runtimeId={agent.runtimeId} size={14} />{runtime?.name ?? agent.runtimeId}</span><p className="goal-meta">{agent.role}</p></Button> }) : <p className="goal-empty-copy">尚未分配 Agent。你也可以先人工整理现状与计划。</p>}</section>
          <section className="goal-section"><SectionTitle icon={<Target size={15} />} title="目标状态" /><Choice label="目标生命周期" value={goal.status} options={goalStatusLabels} onChange={status => void persist(changeGoal(goal.id, current => setGoalStatus(current, status as GoalStatus)), `目标状态已更新为${goalStatusLabels[status as GoalStatus]}。`)} /><p className="goal-meta goal-note">任务完成不自动代表目标达成。</p>{goal.deadline && <p className="goal-meta">期望日期 · {goal.deadline}</p>}{goal.constraints && <><h3 className="goal-context-label">范围与约束</h3><p className="goal-context-copy">{goal.constraints}</p></>}{goal.intent && <><h3 className="goal-context-label">为什么推进</h3><p className="goal-context-copy">{goal.intent}</p></>}</section>
          <section className="goal-section"><SectionTitle icon={<CalendarClock size={15} />} title="最近复盘" />{goal.reviews.at(-1) ? <><p className="goal-context-copy">{goal.reviews.at(-1)!.summary}</p><Button variant="link" className="goal-text-link" onClick={() => setTab('reviews')}>查看复盘 <ArrowRight size={12} /></Button></> : <p className="goal-empty-copy">阶段结束或获得新证据时，记录变化与下一步。</p>}<Button variant="outline" size="sm" onClick={() => open('review', { judgement: 'unknown' })}>记录复盘</Button></section>
        </aside></div></TabsContent>
        <TabsContent value="tasks" className="goal-scroll"><SectionTitle icon={<ListChecks size={15} />} title="关联任务" /><p className="goal-helper">行动进展与目标成功条件分别记录。执行结束后，检查结果并决定是否更新现状。</p><TaskRows tasks={selectedTasks} /></TabsContent>
        <TabsContent value="history" className="goal-scroll"><SectionTitle icon={<History size={15} />} title="现状修订与目标版本"><span className="goal-meta">保留来源和历史快照</span></SectionTitle>{[...goal.stateHistory].reverse().map(snapshot => <article className="goal-history-row" key={`state-${snapshot.version}`}><div><Badge variant="outline">现状 v{snapshot.version}</Badge><strong>{snapshot.reason}</strong><time>{when(snapshot.createdAt)}</time></div><p className="goal-meta"><Source source={snapshot.source} /></p><HistoryDisclosure title={`查看现状 v${snapshot.version} 的快照`}><p>{snapshot.summary || '没有整体描述'}</p>{snapshot.entries.map(entry => <p key={entry.id}><span className="goal-meta">{goalEntryLabels[entry.kind]} · </span>{entry.text}</p>)}</HistoryDisclosure></article>)}{[...goal.definitions].reverse().map(definition => <article className="goal-history-row" key={`definition-${definition.version}`}><div><Badge variant="outline">目标 v{definition.version}</Badge><strong>{definition.reason}</strong><time>{when(definition.createdAt)}</time></div><HistoryDisclosure title={`查看目标 v${definition.version} 的定义`}><p>{definition.title}</p><p>{definition.expected || '预期尚待澄清'}</p>{definition.criteria.map(criterion => <p key={criterion.id}>{criterion.text}</p>)}{definition.constraints && <p>约束：{definition.constraints}</p>}</HistoryDisclosure></article>)}</TabsContent>
        <TabsContent value="reviews" className="goal-scroll"><div className="goal-review-toolbar"><div><h2>复盘与下一步</h2><p className="goal-meta">保留当时的目标定义、前后现状和判断依据。</p></div><div><Button variant="outline" size="sm" onClick={() => { const schedule = goal.reviewSchedule; open('schedule', { enabled: String(schedule?.enabled ?? false), weekday: String(schedule?.weekday ?? 1), hour: String(schedule?.hour ?? 9), timeZone: schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }) }}><CalendarClock size={14} />{goal.reviewSchedule?.enabled ? '每周复盘已开启' : '设置周期'}</Button><Button size="sm" onClick={() => open('review', { judgement: 'unknown' })}><Plus size={13} />记录复盘</Button></div></div>{goal.reviewSchedule?.enabled && <p className="goal-schedule-note">每周{['日', '一', '二', '三', '四', '五', '六'][goal.reviewSchedule.weekday]} {String(goal.reviewSchedule.hour).padStart(2, '0')}:00 · {goal.reviewSchedule.timeZone}。应用运行时整理快照；重新打开时补记最近一期，进度判断由你确认。</p>}{!goal.reviews.length && <div className="goal-review-empty"><CalendarClock size={24} /><h3>还没有复盘记录</h3><p>变化说明了什么？原计划还合适吗？下一步准备做什么？</p></div>}{[...goal.reviews].reverse().map(review => <article className="goal-review" key={review.id}><div className="goal-section-title"><h2>{review.trigger === 'weekly' ? '周期现状快照' : '手动复盘'}<Badge variant="outline">{reviewJudgementLabels[review.judgement]}</Badge></h2><time className="goal-meta">{when(review.createdAt)}</time></div><p className="goal-review-summary">{review.summary}</p><p className="goal-helper">{review.evidence || '尚未记录判断依据。'}</p><div className="goal-meta">目标 v{review.definition.version} · 现状 v{review.beforeState.version} → v{review.afterState.version}{review.scheduledFor && ` · 原定 ${when(review.scheduledFor)}`}</div>{review.needsAssessment && <Button size="sm" variant="outline" className="goal-note" onClick={() => open('review', { judgement: 'unknown', summary: '', evidence: `参考 ${when(review.createdAt)} 周期快照；`, actions: '' })}>补充进度判断</Button>}<HistoryDisclosure title="查看当时的目标与前后现状"><p><strong>{review.definition.title}</strong> · {review.definition.expected}</p><p>复盘前：{review.beforeState.summary || '未填写整体描述'}</p>{review.beforeState.entries.map(entry => <p key={`before-${entry.id}`} className="goal-meta">{goalEntryLabels[entry.kind]}：{entry.text}</p>)}<p>复盘后：{review.afterState.summary || '未填写整体描述'}</p>{review.afterState.entries.map(entry => <p key={`after-${entry.id}`} className="goal-meta">{goalEntryLabels[entry.kind]}：{entry.text}</p>)}</HistoryDisclosure>{review.nextActions.length > 0 && <div className="goal-next-actions"><h3>下一步行动</h3>{review.nextActions.map((action, index) => <div key={index}><span>{action}</span><Button variant="outline" size="sm" onClick={() => onCreateTask(goal.id, action)}>创建任务 <ArrowRight size={12} /></Button></div>)}</div>}</article>)}</TabsContent>
      </Tabs>
    </main>}
    </GoalListLayout>
    <Dialog open={modal !== null} onOpenChange={isOpen => { if (!isOpen) { setModal(null); setError('') } }}><DialogContent className="goal-dialog" onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus() } }}><DialogHeader><DialogTitle>{modal ? modalTitles[modal] : '目标'}</DialogTitle><DialogDescription>{modal === 'create' ? '先描述想做的事情，其他信息可以后续完善。' : modal === 'state' ? '事实、假设和未知分别记录。每次修订保留来源与旧版现状。' : modal === 'review' ? '结合明确的预期和证据判断进展；信息不足时保留“暂无法判断”。' : modal === 'schedule' ? '周期检查保存事实快照，不会自动编造结论或启动任务。' : '保存后保留历史依据，不改写已有执行中的快照。'}</DialogDescription></DialogHeader><form onSubmit={submit} className="goal-form">
      {(modal === 'create' || modal === 'edit') && <><Field label="目标名称" id="goal-title"><Input id="goal-title" autoFocus value={draft.title ?? ''} onChange={event => field('title', event.target.value)} placeholder="描述你希望推进的事情" /></Field><Field label="预期结果" id="goal-expected"><Textarea id="goal-expected" value={draft.expected ?? ''} onChange={event => field('expected', event.target.value)} placeholder="希望最终达到什么状态？" rows={2} /></Field><Field label="为什么做" id="goal-intent"><Input id="goal-intent" value={draft.intent ?? ''} onChange={event => field('intent', event.target.value)} placeholder="可选，记录目标的背景" /></Field><Field label="成功条件" id="goal-criteria" hint="每行一项，可以是可交付成果、能力验证、结论或指标。"><Textarea id="goal-criteria" value={draft.criteria ?? ''} onChange={event => field('criteria', event.target.value)} rows={3} /></Field>{modal === 'create' ? <Field label="当前现状" id="goal-summary"><Textarea id="goal-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={2} placeholder="可选：已知什么，还缺少什么？" /></Field> : <><Field label="范围与约束" id="goal-constraints"><Textarea id="goal-constraints" value={draft.constraints ?? ''} onChange={event => field('constraints', event.target.value)} rows={2} /></Field><Field label="期望日期（可选）" id="goal-deadline"><Input id="goal-deadline" type="date" value={draft.deadline ?? ''} onChange={event => field('deadline', event.target.value)} /></Field><Field label="本次修订原因" id="goal-reason"><Input id="goal-reason" value={draft.reason ?? ''} onChange={event => field('reason', event.target.value)} /></Field></>}</>}
      {modal === 'state' && <><Field label="整体描述" id="goal-state-summary"><Textarea id="goal-state-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={3} /></Field><Field label={draft.entryId ? '修订条目' : '新增条目（可选）'} id="goal-state-text"><Textarea id="goal-state-text" value={draft.text ?? ''} onChange={event => field('text', event.target.value)} rows={3} placeholder="已有事实、成果、未知问题或查询方式" /></Field><div className="goal-form-pair"><Field label="内容类型" id="goal-entry-kind"><Choice label="内容类型" value={draft.kind ?? 'fact'} onChange={value => field('kind', value)} options={goalEntryLabels} /></Field><Field label="来源类型" id="goal-source-kind"><Choice label="来源类型" value={draft.sourceKind ?? 'user'} onChange={value => field('sourceKind', value)} options={{ user: '用户提供', file: '文件 / 文档', url: '网页 / 资料', tool: '查询 / 工具', task: '任务结果' }} /></Field></div>{draft.kind === 'metric' && <><div className="goal-form-pair"><Field label="指标名称" id="goal-metric-name"><Input id="goal-metric-name" value={draft.metricName ?? ''} onChange={event => field('metricName', event.target.value)} /></Field><Field label="观测数值" id="goal-metric-value"><Input id="goal-metric-value" type="number" step="any" value={draft.metricValue ?? ''} onChange={event => field('metricValue', event.target.value)} /></Field></div><Field label="单位" id="goal-metric-unit"><Input id="goal-metric-unit" value={draft.metricUnit ?? ''} onChange={event => field('metricUnit', event.target.value)} /></Field><Field label="统计口径与观察窗口" id="goal-metric-definition"><Input id="goal-metric-definition" value={draft.metricDefinition ?? ''} onChange={event => field('metricDefinition', event.target.value)} /></Field></>}<Field label="来源说明" id="goal-source"><Input id="goal-source" value={draft.sourceLabel ?? ''} onChange={event => field('sourceLabel', event.target.value)} /></Field><Field label="文件、链接或查询方式（可选）" id="goal-reference"><Input id="goal-reference" value={draft.reference ?? ''} onChange={event => field('reference', event.target.value)} /></Field><Field label="变化原因" id="goal-state-reason"><Input id="goal-state-reason" value={draft.reason ?? ''} onChange={event => field('reason', event.target.value)} placeholder="什么发生了变化，依据是什么？" /></Field></>}
      {modal === 'criterion' && <><p className="goal-form-context">{modalGoal?.criteria.find(item => item.id === draft.criterionId)?.text}</p><Field label="检查结果" id="goal-criterion-status"><Choice label="检查结果" value={draft.status ?? 'unverified'} onChange={value => field('status', value)} options={criterionLabels} /></Field><Field label="验收依据" id="goal-criterion-evidence" hint="可以记录验证方法、产物位置或用户确认；未验证时无需假定已通过。"><Textarea id="goal-criterion-evidence" value={draft.evidence ?? ''} onChange={event => field('evidence', event.target.value)} rows={4} /></Field></>}
      {modal === 'plan' && <><Field label="阶段名称" id="goal-stage-title"><Input id="goal-stage-title" value={draft.title ?? ''} onChange={event => field('title', event.target.value)} /></Field><Field label="推进方向与调整说明" id="goal-stage-description"><Textarea id="goal-stage-description" value={draft.description ?? ''} onChange={event => field('description', event.target.value)} rows={4} /></Field><Field label="阶段状态" id="goal-stage-status"><Choice label="阶段状态" value={draft.status ?? 'planned'} onChange={value => field('status', value)} options={stageLabels} /></Field></>}
      {modal === 'review' && <><Field label="进度判断" id="goal-review-judgement"><Choice label="进度判断" value={draft.judgement ?? 'unknown'} onChange={value => field('judgement', value)} options={reviewJudgementLabels} /></Field><Field label="复盘结论" id="goal-review-summary"><Textarea id="goal-review-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={3} placeholder="发生了什么变化？原计划是否仍然合理？" /></Field><Field label="预期标准与判断依据" id="goal-review-evidence"><Textarea id="goal-review-evidence" value={draft.evidence ?? ''} onChange={event => field('evidence', event.target.value)} rows={3} /></Field><Field label="下一步行动" id="goal-review-actions" hint="每行一项，保存后可以分别转成任务。"><Textarea id="goal-review-actions" value={draft.actions ?? ''} onChange={event => field('actions', event.target.value)} rows={3} /></Field></>}
      {modal === 'schedule' && <><div className="goal-switch-row"><Label htmlFor="goal-schedule-enabled">每周保存复盘快照</Label><Switch id="goal-schedule-enabled" checked={draft.enabled === 'true'} onCheckedChange={checked => field('enabled', String(checked))} /></div><div className="goal-form-pair"><Field label="星期" id="goal-weekday"><Choice label="星期" value={draft.weekday ?? '1'} onChange={value => field('weekday', value)} options={{ '1': '星期一', '2': '星期二', '3': '星期三', '4': '星期四', '5': '星期五', '6': '星期六', '0': '星期日' }} /></Field><Field label="时间（整点）" id="goal-hour"><Input id="goal-hour" type="number" min="0" max="23" value={draft.hour ?? '9'} onChange={event => field('hour', event.target.value)} /></Field></div><Field label="时区" id="goal-timezone"><Input id="goal-timezone" value={draft.timeZone ?? ''} onChange={event => field('timeZone', event.target.value)} /></Field><p className="goal-helper">应用运行时执行；退出期间不会运行。再次打开会补记最近错过的一期，按目标和周期去重，并记录实际保存时间。需要你补充证据和判断。</p></>}
      {modal === 'proposal' && proposal && <ProposalDetails proposal={proposal} currentVersion={modalGoal?.currentState.version ?? 0} />}
      {error && <p role="alert" className="goal-form-error">{error}</p>}<DialogFooter className="goal-dialog-footer"><Button type="button" variant="outline" onClick={() => setModal(null)}>取消</Button><Button type="submit" disabled={saving}>{saving ? '保存中…' : modal === 'create' ? '创建目标' : modal === 'proposal' ? proposal?.baseStateVersion !== modalGoal?.currentState.version ? '已核对，重新生成建议' : '采纳到现状' : '保存'}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </div>
}

function ProposalDetails({ proposal, currentVersion }: { proposal: GoalStateProposal; currentVersion: number }) {
  return <div className="goal-proposal-details"><p><strong>{proposal.title}</strong></p><p className="goal-meta">{proposal.source.label} · 基于现状 v{proposal.baseStateVersion} · 当前 v{currentVersion}</p>{proposal.entries.map(entry => <div className="goal-form-context" key={entry.id}><span className="goal-meta">{goalEntryLabels[entry.kind]}</span><p>{entry.text}</p><p className="goal-meta">{entry.source.label}{entry.source.reference && ` · ${entry.source.reference}`}</p></div>)}<p className="goal-helper">采纳后将这些条目追加到现状，并保留来源；现有事实不会被覆盖。</p>{proposal.baseStateVersion !== currentVersion && <p className="goal-form-error">这条建议产生后现状已变化。请与当前现状核对，重新生成建议后再采纳。</p>}</div>
}

export default GoalsPage
