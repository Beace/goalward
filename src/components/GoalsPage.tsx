import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { ArrowRight, BookOpen, CalendarClock, Check, Circle, FileCheck2, Flag, History, ListChecks, Pencil, Plus, Search, Target, Users } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import type { AppState, Task } from '@/lib/types'
import type { Goal, GoalCriterion, GoalEntryKind, GoalPlanStage, GoalReview, GoalSource, GoalStateProposal, GoalStatus } from '@/lib/goal-types'
import { acceptGoalProposal, createGoal, createStateEntry, rebaseGoalProposal, reviseGoal, saveGoalReview, setGoalStatus, updateCriterion, updateGoalState, validateReviewSchedule } from '@/lib/goals'
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
import { GoalAssistant, GoalTaskProposals, persistGoalAssistantAction } from './GoalAssistant'
import { GoalCelebration } from './GoalCelebration'
import { GoalProgress } from './GoalProgress'
import { confirmGoalAssistantDraft } from '@/lib/goal-assistant'
import type { GoalAssistantDraftSource } from '@/lib/goal-assistant'
import type { GoalAssistantDraft } from '@/lib/goal-types'
import { isDesktop } from '@/lib/bridge'
import { getCriterionProgressStatus, isBusinessTask } from '@/lib/goal-progress'
import { getCurrentLanguage, translate, useI18n } from '@/i18n'
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
  onSendAssistant?: (goalId: string, input: string, phase: 'clarify' | 'plan', runtimeId?: string) => Promise<void>
  onStopAssistant?: (goalId: string) => Promise<void>
  onPrepareAssistant?: (taskId: string) => Promise<void>
  onSettings?: () => void
  explorationRequest?: number
  viewRequest?: { goalId: string; tab: string; focusProgress?: boolean; request: number }
  onViewChange?: (goalId: string, tab: string) => void
}
type Modal = 'create' | 'edit' | 'state' | 'criterion' | 'plan' | 'review' | 'schedule' | 'proposal' | null
type Draft = Record<string, string>
const lines = (value = '') => value.split('\n').map(line => line.trim()).filter(Boolean)
const now = () => new Date().toISOString()
const when = (value: string) => new Date(value).toLocaleString(getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const taskLabels = () => ({ todo: translate('待开始', 'To do'), in_progress: translate('进行中', 'In progress'), blocked: translate('受阻', 'Blocked'), review: translate('待验收', 'In review'), done: translate('已完成', 'Done'), cancelled: translate('已取消', 'Cancelled') })
const stageLabels = (): Record<GoalPlanStage['status'], string> => ({ planned: translate('待推进', 'Planned'), active: translate('进行中', 'In progress'), done: translate('已完成', 'Done'), blocked: translate('受阻', 'Blocked') })
const criterionLabels = (): Record<GoalCriterion['status'], string> => ({ unverified: translate('待验证', 'Unverified'), satisfied: translate('已满足', 'Satisfied'), unsatisfied: translate('尚未满足', 'Not satisfied') })
const goalStatusLabelsLocalized = (): Record<GoalStatus, string> => ({ clarifying: translate('待澄清', 'Needs clarification'), active: translate('推进中', 'In progress'), paused: translate('已暂停', 'Paused'), achieved: translate('已达成', 'Achieved'), maintenance: translate('维护中', 'Maintaining'), ended: translate('已结束', 'Ended') })
const goalEntryLabelsLocalized = (): Record<GoalEntryKind, string> => ({ fact: translate('已知事实', 'Known fact'), artifact: translate('已有成果', 'Existing artifact'), decision: translate('已作决定', 'Decision'), hypothesis: translate('待验证假设', 'Hypothesis'), unknown: translate('未知问题', 'Open question'), blocker: translate('当前障碍', 'Blocker'), metric: translate('指标观测', 'Metric') })
const reviewJudgementLabelsLocalized = (): Record<GoalReview['judgement'], string> => ({ on_track: translate('符合预期', 'On track'), at_risk: translate('存在风险', 'At risk'), off_track: translate('偏离预期', 'Off track'), unknown: translate('暂无法判断', 'Undetermined') })
const modalTitles = (): Record<Exclude<Modal, null>, string> => ({ create: translate('创建目标', 'Create goal'), edit: translate('修订目标与成功条件', 'Revise goal and success criteria'), state: translate('更新现状', 'Update context'), criterion: translate('检查成功条件', 'Check success criterion'), plan: translate('编辑推进阶段', 'Edit stage'), review: translate('记录复盘', 'Record review'), schedule: translate('周期复盘', 'Recurring review'), proposal: translate('核对现状变化建议', 'Review context change proposal') })

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
  return <div className="goal-field"><Label htmlFor={id}>{label}</Label>{children}{hint && <p className="goal-meta">{hint}</p>}</div>
}
function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Record<string, string> }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select>
}
function SectionTitle({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="goal-section-title"><h2>{icon}{title}</h2>{children}</div>
}
function GoalBadge({ status }: { status: GoalStatus }) { return <Badge variant="outline" className={`goal-status goal-status-${status}`}>{goalStatusLabelsLocalized()[status]}</Badge> }

function HistoryDisclosure({ title, children }: { title: string; children: ReactNode }) { return <Collapsible><CollapsibleTrigger className="goal-disclosure"><CollapsibleIndicator size={13} />{title}</CollapsibleTrigger><CollapsibleContent><div className="goal-history-detail">{children}</div></CollapsibleContent></Collapsible> }

export function GoalsPage({ state, onChange, onCreateTask, onOpenTask, onOpenAgent, selectedGoalId, onSelectGoal, hideGoalList, goalListWidth, onSendAssistant, onStopAssistant, onPrepareAssistant, onSettings, explorationRequest, viewRequest, onViewChange }: GoalsPageProps) {
  const { t } = useI18n()
  const [localId, setLocalId] = useState(state.goals[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('overview')
  const [modal, setModal] = useState<Modal>(null)
  const [modalGoalId, setModalGoalId] = useState('')
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [exploring, setExploring] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [assistantActionError, setAssistantActionError] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const progressFocus = useRef<HTMLDivElement>(null)
  const goal = state.goals.find(item => item.id === (selectedGoalId || localId)) ?? state.goals[0]
  const selectedTasks = goal ? state.tasks.filter(task => task.goalId === goal.id && isBusinessTask(task)) : []
  const participants = goal ? state.agents.filter(agent => agent.assignedGoalIds.includes(goal.id)) : []
  const modalGoal = state.goals.find(item => item.id === modalGoalId)
  const proposal = modalGoal?.proposals.find(item => item.id === draft.proposalId)
  const modalCriterion = modalGoal?.criteria.find(item => item.id === draft.criterionId)
  const chooseGoal = (goalId: string) => { setLocalId(goalId); onSelectGoal?.(goalId); setExploring(false); setTab('overview'); setError(''); setAssistantActionError(''); onViewChange?.(goalId, 'overview') }
  const field = (name: string, value: string) => setDraft(current => ({ ...current, [name]: value }))
  const dismissCelebration = useCallback(() => setCelebrating(false), [])
  const selectTab = (value: string) => { setTab(value); if (goal) onViewChange?.(goal.id, value) }
  useEffect(() => { if (explorationRequest) { setExploring(true); setAssistantActionError('') } }, [explorationRequest])
  useEffect(() => {
    if (!viewRequest) return
    setExploring(false); setLocalId(viewRequest.goalId); setTab(viewRequest.tab); setAssistantActionError('')
  }, [viewRequest?.request, viewRequest?.goalId, viewRequest?.tab])
  useEffect(() => {
    if (!viewRequest?.focusProgress || tab !== 'overview') return
    progressFocus.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
    progressFocus.current?.focus({ preventScroll: true })
  }, [viewRequest?.request, viewRequest?.focusProgress, tab])

  async function startIdea(idea: string, runtimeId?: string) {
    const created = createGoal({ title: idea })
    created.assistant = { input: idea }
    await persistGoalAssistantAction(onChange, previous => ({ ...previous, goals: [...previous.goals, created], activeGoalId: created.id, goalExplorationInput: '' }))
    setLocalId(created.id); onSelectGoal?.(created.id); setExploring(false); setTab('assistant'); onViewChange?.(created.id, 'assistant')
    if (isDesktop && onSendAssistant && runtimeId) {
      try { await onSendAssistant(created.id, idea, 'clarify', runtimeId) }
      catch (cause) { setAssistantActionError(String(cause instanceof Error ? cause.message : cause)) }
    }
  }
  async function confirmAssistant(draft: GoalAssistantDraft, runtimeId: string | undefined, source: GoalAssistantDraftSource) {
    if (!goal) return
    const wasConfirmed = Boolean(goal.assistant?.confirmedVersion)
    await persistGoalAssistantAction(onChange, previous => confirmGoalAssistantDraft(previous, goal.id, draft, source))
    if (!wasConfirmed) setCelebrating(true)
    setTab('tasks'); onViewChange?.(goal.id, 'tasks'); setAssistantActionError('')
    if (isDesktop && onSendAssistant && runtimeId) {
      try { await onSendAssistant(goal.id, t('根据刚确认的目标，提议可执行任务，明确交付、验收、依赖与期望日期。', 'Propose executable tasks for the confirmed goal, with delivery, acceptance, dependencies, and target dates.'), 'plan', runtimeId) }
      catch (cause) { setAssistantActionError(String(cause instanceof Error ? cause.message : cause)) }
    }
  }
  async function retryPlan() {
    if (!goal || !onSendAssistant) return
    setAssistantActionError('')
    await onSendAssistant(goal.id, t('请重新提议任务，保留用户已经修改或采用的任务。', 'Propose tasks again while preserving tasks already edited or adopted by the user.'), 'plan')
  }

  function open(type: Exclude<Modal, null>, values: Draft = {}) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft(values); setModalGoalId(goal?.id ?? ''); setError(''); setModal(type)
  }
  async function persist(reducer: (state: AppState) => AppState, success: string, close = false) {
    setSaving(true); setError('')
    try { await persistGoalAssistantAction(onChange, reducer); notify.success(success); if (close) setModal(null); return true } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); if (modal) setError(message); else notify.error(message); return false } finally { setSaving(false) }
  }
  const changeGoal = (goalId: string, updater: (goal: Goal) => Goal) => (previous: AppState): AppState => {
    if (!previous.goals.some(item => item.id === goalId)) throw new Error(t('目标已不存在，请刷新后再试。', 'Goal no longer exists. Refresh and try again.'))
    return { ...previous, goals: previous.goals.map(item => item.id === goalId ? updater(item) : item) }
  }
  function editGoal() {
    if (!goal) return
    open('edit', { title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, criteria: goal.criteria.map(item => item.text).join('\n'), reason: '', baseVersion: String(goal.version) })
  }
  function editState(entryId = '') {
    if (!goal) return
    const entry = goal.currentState.entries.find(item => item.id === entryId)
    open('state', { summary: goal.currentState.summary, text: entry?.text ?? '', kind: entry?.kind ?? 'fact', sourceLabel: entry?.source.label ?? t('用户提供', 'User provided'), sourceKind: entry?.source.kind ?? 'user', reference: entry?.source.reference ?? '', reason: '', entryId, baseVersion: String(goal.currentState.version), metricName: entry?.metric?.name ?? '', metricValue: entry?.metric ? String(entry.metric.value) : '', metricUnit: entry?.metric?.unit ?? '', metricDefinition: entry?.metric?.definition ?? '' })
  }
  function editPlan(stage?: GoalPlanStage) { open('plan', { stageId: stage?.id ?? '', title: stage?.title ?? '', description: stage?.description ?? '', status: stage?.status ?? 'planned' }) }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || !modal) return
    if (modal === 'create') {
      let created: Goal
      try { created = createGoal({ title: draft.title ?? '', intent: draft.intent, expected: draft.expected, currentSummary: draft.summary, deadline: draft.deadline, criteria: lines(draft.criteria) }) } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); return }
      const saved = await persist(previous => ({ ...previous, goals: [...previous.goals, created] }), t('目标已创建，可继续补充现状与任务。', 'Goal created. You can add context and tasks next.'), true)
      if (!saved) return
      // Selection is local UI state; creation itself does not require a Runtime.
      setLocalId(created.id); onSelectGoal?.(created.id); setExploring(false); setTab('overview')
      return
    }
    if (!modalGoal) { setError(t('请重新选择目标。', 'Select the goal again.')); return }
    await persist(changeGoal(modalGoal.id, current => {
      if (modal === 'edit') {
        if (current.version !== Number(draft.baseVersion)) throw new Error(t('目标已被修订，请重新打开并核对最新版本。', 'Goal has changed. Reopen it and review the latest version.'))
        return reviseGoal(current, { title: draft.title ?? '', intent: draft.intent ?? '', expected: draft.expected ?? '', constraints: draft.constraints ?? '', deadline: draft.deadline ?? '', criteria: lines(draft.criteria).map(text => current.criteria.find(item => item.text === text) ?? text), reason: draft.reason ?? '' })
      }
      if (modal === 'state') {
        const previousSource = current.currentState.entries.find(item => item.id === draft.entryId)?.source
        const source: GoalSource = { ...(previousSource?.kind === draft.sourceKind ? previousSource : {}), kind: (draft.sourceKind ?? 'user') as GoalSource['kind'], label: draft.sourceLabel?.trim() || t('用户提供', 'User provided'), reference: draft.reference?.trim() || undefined }
        let entries = current.currentState.entries
        if (draft.text?.trim()) {
          const entry = createStateEntry(draft.kind as GoalEntryKind, draft.text, source)
          if (draft.kind === 'metric') {
            if (!draft.metricName?.trim() || !draft.metricDefinition?.trim() || !draft.metricValue?.trim() || !Number.isFinite(Number(draft.metricValue))) throw new Error(t('指标观测需要名称、数值和统计口径。', 'A metric needs a name, value, and measurement definition.'))
            entry.metric = { name: draft.metricName.trim(), value: Number(draft.metricValue), unit: draft.metricUnit?.trim() ?? '', definition: draft.metricDefinition.trim(), observedAt: now() }
          }
          if (draft.entryId) entries = entries.map(item => item.id === draft.entryId ? { ...entry, id: item.id } : item)
          else entries = [...entries, entry]
        } else if (draft.entryId) throw new Error(t('修订现状条目时内容不能为空。', 'A revised context entry cannot be empty.'))
        return updateGoalState(current, { summary: draft.summary ?? '', entries, reason: draft.reason ?? '', source, baseStateVersion: Number(draft.baseVersion) })
      }
      if (modal === 'criterion') return updateCriterion(current, draft.criterionId, draft.status as GoalCriterion['status'], draft.evidence ?? '')
      if (modal === 'plan') {
        if (!draft.title?.trim()) throw new Error(t('请填写阶段名称。', 'Enter a stage name.'))
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
        if (!item) throw new Error(t('找不到该建议。', 'Proposal not found.'))
        return item.baseStateVersion === current.currentState.version ? acceptGoalProposal(current, item.id) : rebaseGoalProposal(current, item.id)
      }
      return current
    }), modal === 'proposal' && proposal?.baseStateVersion !== modalGoal.currentState.version ? t('已保留旧建议并生成重新核对的版本，请确认采纳。', 'The old proposal was kept and a new version is ready for review.') : t('已保存，历史版本与执行快照保持可追溯。', 'Saved. Historical versions and run snapshots remain traceable.'), true)
  }

  function TaskRows({ tasks }: { tasks: Task[] }) {
    return tasks.length ? <div className="goal-task-list">{tasks.map(task => <div className="goal-task-row" key={task.id}><ListChecks size={14} /><div><Button variant="link" className="goal-text-link" onClick={() => onOpenTask(task.id)}>{task.title}</Button><p className="goal-meta">{task.executor === 'human' ? t('人工完成', 'Human task') : `${task.members.length} ${t('位成员', 'members')}`}{task.acceptance ? ` · ${task.acceptance}` : ` · ${t('尚未填写验收要求', 'Acceptance criteria not set')}`}</p></div><Badge variant="outline">{taskLabels()[task.businessStatus ?? 'todo']}</Badge><Button size="icon-sm" variant="ghost" aria-label={`${t('打开任务', 'Open task')}: ${task.title}`} onClick={() => onOpenTask(task.id)}><ArrowRight size={14} /></Button></div>)}</div> : <p className="goal-empty-copy">{t('还没有关联任务。可以从下一步行动开始，也可以先补充资料。', 'No linked tasks yet. Start from a next action or add more context first.')}</p>
  }
  function ProposalRows() {
    const pending = goal?.proposals.filter(item => item.status === 'pending') ?? []
    if (!pending.length) return null
    return <section className="goal-section"><SectionTitle icon={<FileCheck2 size={15} />} title={t('待采纳变化', 'Pending changes')}><Badge variant="outline">{pending.length}</Badge></SectionTitle>{pending.map(item => <div className="goal-proposal" key={item.id}><p>{item.title}</p><p className="goal-meta">{item.source.label} · {t('基于现状', 'Based on context')} v{item.baseStateVersion}{item.baseStateVersion !== goal?.currentState.version ? ` · ${t('需要重新核对', 'Needs review')}` : ''}</p><div className="goal-row-actions"><Button variant="ghost" size="sm" disabled={saving} onClick={() => void persist(changeGoal(goal!.id, current => ({ ...current, updatedAt: now(), proposals: current.proposals.map(proposal => proposal.id === item.id ? { ...proposal, status: 'rejected', resolvedAt: now() } : proposal) })), t('变化建议已保留为未采纳。', 'Change proposal kept as not accepted.'))}>{t('不采纳', 'Decline')}</Button><Button variant="outline" size="sm" onClick={() => open('proposal', { proposalId: item.id })}>{t('核对变化', 'Review change')}</Button></div></div>)}</section>
  }
  function Source({ source }: { source: GoalSource }) { return <span>{source.label}{source.reference && <> · {source.reference}</>}{source.taskId && (state.tasks.some(task => task.id === source.taskId) ? <> · <Button variant="link" className="goal-inline-link" onClick={() => onOpenTask(source.taskId!)}>{t('查看来源任务', 'View source task')}</Button></> : <> · {t('来源任务已删除', 'Source task was deleted')}</>)}</span> }

  return <div className={`goals-page${hideGoalList ? ' goals-without-list' : ''}`}>
    <AnimatePresence>{celebrating && <GoalCelebration onDismiss={dismissCelebration} />}</AnimatePresence>
    <GoalListLayout rememberedWidth={goalListWidth} navigation={!hideGoalList && <aside className="goal-picker" aria-label={t('目标列表', 'Goal list')}><div className="goal-picker-heading"><span><Target size={15} />{t('目标', 'Goals')}</span><Button size="icon-sm" variant="ghost" aria-label={t('开始一件事', 'Start something')} title={t('开始一件事', 'Start something')} onClick={() => setExploring(true)}><Plus size={16} /></Button></div><div className="goal-search"><Search size={14} /><Input aria-label={t('搜索目标', 'Search goals')} placeholder={t('搜索目标…', 'Search goals…')} value={search} onChange={event => setSearch(event.target.value)} /></div><div className="goal-picker-list">{(state.goalExplorationInput || exploring) && <Button variant="ghost" className={`goal-choice${exploring ? ' is-selected' : ''}`} aria-label={t('恢复未完成的探索', 'Resume exploration')} aria-pressed={exploring} onClick={() => setExploring(true)}><span title={state.goalExplorationInput || t('新的想法', 'New idea')}>{state.goalExplorationInput || t('新的想法', 'New idea')}</span><small>{t('探索中', 'Exploring')}</small></Button>}{state.goals.filter(item => `${item.title} ${item.expected}`.toLowerCase().includes(search.toLowerCase())).map(item => <Button key={item.id} variant="ghost" className={`goal-choice${item.id === goal?.id && !exploring ? ' is-selected' : ''}`} aria-label={`${t('打开目标：', 'Open goal: ')}${item.title}`} aria-pressed={item.id === goal?.id && !exploring} onClick={() => chooseGoal(item.id)}><span title={item.title}>{item.title}</span><small>{goalStatusLabelsLocalized()[item.status]} · v{item.version}</small></Button>)}{!state.goals.length && <p className="goal-empty-copy">{t('把想推进的事情记录在这里。', 'Capture what you want to move forward here.')}</p>}</div><div className="goal-picker-footer">{t('目标与现状持续保存', 'Goals and context are saved')}<br />{t('执行按任务组织', 'Runs are organized by task')}</div></aside>}>
    {exploring || !goal ? <main className="goal-detail"><div className="goal-exploration-toolbar"><span>{t('从想法开始', 'Start from an idea')}</span>{goal && <Button variant="ghost" size="sm" onClick={() => setExploring(false)}>{t('返回目标', 'Back to goal')}</Button>}<Button variant="ghost" size="sm" onClick={() => open('create')}>{t('手动创建目标', 'Create goal manually')}</Button></div><GoalAssistant state={state} onChange={onChange} onStart={startIdea} onSettings={onSettings} onConfirm={confirmAssistant} />{!goal && <div className="goal-manual-start"><Button variant="ghost" size="sm" onClick={() => open('create')}>{t('创建第一个目标', 'Create your first goal')}</Button></div>}</main> : <main className="goal-detail">
      <header className="goal-header"><div className="goal-heading"><div><p className="goal-meta">{t('目标', 'Goal')} / <GoalBadge status={goal.status} /> <span>{t('定义', 'Definition')} v{goal.version} · {t('现状', 'Context')} v{goal.currentState.version}</span></p><h1>{goal.title}</h1><p className="goal-subtitle">{goal.expected || t('先记录想做的事，再逐步明确预期结果。', 'Capture your goal first, then refine the expected outcome.')}</p>{goal.deadline && <p className="goal-deadline"><CalendarClock size={13} />{t('期望日期', 'Target date')} · <time>{goal.deadline}</time></p>}</div><div className="goal-header-actions"><Button variant="outline" onClick={() => selectTab('assistant')}>{t('目标助手', 'Goal assistant')}</Button><Button variant="outline" onClick={() => editState()}><Pencil size={14} />{t('更新现状', 'Update context')}</Button><Button onClick={() => onCreateTask(goal.id)}><Plus size={14} />{t('创建任务', 'Create task')}</Button></div></div></header>
      {assistantActionError && <p className="goal-form-error goal-assistant-page-error" role="alert">{assistantActionError}</p>}
      <Tabs value={tab} onValueChange={selectTab} className="goal-tabs"><TabsList variant="line" aria-label={t('目标内容', 'Goal content')}><TabsTrigger value="overview">{t('概览', 'Overview')}</TabsTrigger><TabsTrigger value="tasks">{t('任务', 'Tasks')} <span className="goal-tab-count">{selectedTasks.length}</span></TabsTrigger><TabsTrigger value="assistant">{t('目标助手', 'Goal assistant')}</TabsTrigger><TabsTrigger value="history">{t('进展记录', 'Progress history')}</TabsTrigger><TabsTrigger value="reviews">{t('复盘', 'Reviews')} <span className="goal-tab-count">{goal.reviews.length}</span></TabsTrigger></TabsList>
        <TabsContent value="overview" className="goal-scroll"><div className="goal-columns"><div className="goal-primary-column">
          <section className="goal-section goal-criteria"><SectionTitle icon={<Flag size={15} />} title={t('预期状态与成功条件', 'Desired outcome and success criteria')}><Button variant="ghost" size="sm" onClick={editGoal}>{t('修订', 'Revise')}</Button></SectionTitle><p className="goal-desired">{goal.expected || t('尚未明确预期状态，点击修订即可补充。', 'No desired outcome yet. Select Revise to add one.')}</p><div ref={progressFocus} tabIndex={-1} data-goal-progress><GoalProgress goal={goal} tasks={selectedTasks} onTasks={() => selectTab('tasks')} onCriterion={criterion => open('criterion', { criterionId: criterion.id, status: criterion.status, evidence: criterion.evidence })} /></div>{goal.criteria.length ? <div className="goal-criterion-list">{goal.criteria.map(criterion => <Button key={criterion.id} variant="ghost" className="goal-criterion" onClick={() => open('criterion', { criterionId: criterion.id, status: criterion.status, evidence: criterion.evidence })}>{getCriterionProgressStatus(criterion) === 'satisfied' ? <Check size={15} /> : <Circle size={13} />}<span>{criterion.text}</span><small>{criterionLabels()[getCriterionProgressStatus(criterion) === 'pending' ? 'unverified' : criterion.status]}</small></Button>)}</div> : <p className="goal-empty-copy">{t('成功条件可以是产物、事实、判断或指标，不要求统一的百分比。', 'Success criteria can be artifacts, facts, decisions, or metrics; they need not share one percentage.')}</p>}</section>
          <ProposalRows />
          <section className="goal-section"><SectionTitle icon={<BookOpen size={15} />} title={t('当前现状', 'Current context')}><span className="goal-meta">v{goal.currentState.version} · {when(goal.currentState.createdAt)}</span></SectionTitle>{goal.currentState.summary && <p className="goal-state-summary">{goal.currentState.summary}</p>}{goal.currentState.entries.length ? goal.currentState.entries.map(entry => <div className={`goal-fact goal-entry-${entry.kind}`} key={entry.id}><span className="goal-entry-kind">{goalEntryLabelsLocalized()[entry.kind]}</span><div><p>{entry.text}</p>{entry.metric && <p className="goal-metric"><strong>{entry.metric.value}{entry.metric.unit}</strong> {entry.metric.name}<span>{entry.metric.definition}</span></p>}<p className="goal-meta"><Source source={entry.source} /> · {when(entry.createdAt)}</p></div><Button size="icon-sm" variant="ghost" aria-label={`${t('修订现状', 'Revise context')}: ${entry.text}`} onClick={() => editState(entry.id)}><Pencil size={12} /></Button></div>) : <p className="goal-empty-copy">{goal.currentState.summary ? t('可以继续补充事实、成果、未知问题及来源。', 'Add facts, artifacts, open questions, and sources as you learn more.') : t('现状还不明确。可以直接描述，也可以记录资料位置和查询方式。', 'Context is still unclear. Describe it or record where to find more information.')}</p>}</section>
          <section className="goal-section"><SectionTitle icon={<ListChecks size={15} />} title={t('推进计划', 'Progress plan')}><Button size="sm" variant="ghost" onClick={() => editPlan()}><Plus size={13} />{t('添加阶段', 'Add stage')}</Button></SectionTitle>{goal.plan.map((stage, index) => <div className="goal-stage" key={stage.id}><span className="goal-stage-index">{String(index + 1).padStart(2, '0')}</span><div><Button className="goal-text-link" variant="link" onClick={() => editPlan(stage)}>{stage.title}</Button><p className="goal-meta">{stage.description || t('可补充这一阶段要解决的问题与预期成果。', 'Describe what this stage should solve and deliver.')}</p></div><Badge variant="outline">{stageLabels()[stage.status]}</Badge></div>)}{!goal.plan.length && <p className="goal-empty-copy">{t('先写下一步，或添加阶段组织后续任务。', 'Record the next step or add stages to organize future tasks.')}</p>}<TaskRows tasks={selectedTasks.slice(0, 5)} />{selectedTasks.length > 5 && <Button size="sm" variant="ghost" onClick={() => setTab('tasks')}>{t('查看全部', 'View all')} {selectedTasks.length} {t('个任务', 'tasks')} <ArrowRight size={13} /></Button>}</section>
        </div><aside className="goal-context-column">
          <section className="goal-section"><SectionTitle icon={<Users size={15} />} title={t('参与 Agents', 'Participating Agents')}><Button variant="ghost" size="sm" onClick={() => onOpenAgent()}>{t('管理', 'Manage')}</Button></SectionTitle>{participants.length ? participants.map(agent => { const runtime = state.settings.runtimes.find(runtime => runtime.id === agent.runtimeId); const running = state.tasks.flatMap(task => task.runs).flatMap(run => run.members).filter(member => member.agentProfileId === agent.id && member.status === 'running').length; return <Button key={agent.id} variant="ghost" className="goal-agent-row" onClick={() => onOpenAgent(agent.id)}><span><strong>{agent.name}</strong><small>{running ? `${running} ${t('个运行中', 'running')}` : agent.enabled ? t('可分配', 'Available') : t('已停用', 'Disabled')}</small></span><span className="goal-agent-runtime"><RuntimeLogo runtime={runtime} runtimeId={agent.runtimeId} size={14} />{runtime?.name ?? agent.runtimeId}</span><p className="goal-meta">{agent.role}</p></Button> }) : <p className="goal-empty-copy">{t('尚未分配 Agent。你也可以先人工整理现状与计划。', 'No Agents assigned. You can still organize context and plans yourself.')}</p>}</section>
          <section className="goal-section"><SectionTitle icon={<Target size={15} />} title={t('目标状态', 'Goal status')} /><Choice label={t('目标生命周期', 'Goal lifecycle')} value={goal.status} options={goalStatusLabelsLocalized()} onChange={status => void persist(changeGoal(goal.id, current => setGoalStatus(current, status as GoalStatus)), `${t('目标状态已更新为', 'Goal status updated to')} ${goalStatusLabelsLocalized()[status as GoalStatus]}.`)} /><p className="goal-meta goal-note">{t('任务完成不自动代表目标达成。', 'Completing tasks does not automatically achieve the goal.')}</p>{goal.constraints && <><h3 className="goal-context-label">{t('范围与约束', 'Scope and constraints')}</h3><p className="goal-context-copy">{goal.constraints}</p></>}{goal.intent && <><h3 className="goal-context-label">{t('为什么推进', 'Why this matters')}</h3><p className="goal-context-copy">{goal.intent}</p></>}</section>
          <section className="goal-section"><SectionTitle icon={<CalendarClock size={15} />} title={t('最近复盘', 'Latest review')} />{goal.reviews.at(-1) ? <><p className="goal-context-copy">{goal.reviews.at(-1)!.summary}</p><Button variant="link" className="goal-text-link" onClick={() => setTab('reviews')}>{t('查看复盘', 'View review')} <ArrowRight size={12} /></Button></> : <p className="goal-empty-copy">{t('阶段结束或获得新证据时，记录变化与下一步。', 'Record changes and next steps when a stage ends or new evidence appears.')}</p>}<Button variant="outline" size="sm" onClick={() => open('review', { judgement: 'unknown' })}>{t('记录复盘', 'Record review')}</Button></section>
        </aside></div></TabsContent>
        <TabsContent value="tasks" className="goal-scroll"><GoalTaskProposals state={state} goal={goal} onChange={onChange} onCreateTask={() => onCreateTask(goal.id)} onOpenTask={onOpenTask} onRetry={isDesktop && onSendAssistant ? retryPlan : undefined} /><SectionTitle icon={<ListChecks size={15} />} title={t('关联任务', 'Linked tasks')} /><p className="goal-helper">{t('行动进展与目标成功条件分别记录。执行结束后，检查结果并决定是否更新现状。', 'Track task progress and goal success criteria separately. After a run, review its result and decide whether to update context.')}</p><TaskRows tasks={selectedTasks} /></TabsContent>
        <TabsContent value="assistant" className="goal-assistant-tab"><GoalAssistant key={goal.id} state={state} goal={goal} onChange={onChange} onStart={startIdea} onSend={onSendAssistant} onStop={onStopAssistant} onPrepare={onPrepareAssistant} onSettings={onSettings} onConfirm={confirmAssistant} /></TabsContent>
        <TabsContent value="history" className="goal-scroll"><SectionTitle icon={<History size={15} />} title={t('现状修订与目标版本', 'Context changes and goal versions')}><span className="goal-meta">{t('保留来源和历史快照', 'Sources and snapshots are preserved')}</span></SectionTitle>{[...goal.stateHistory].reverse().map(snapshot => <article className="goal-history-row" key={`state-${snapshot.version}`}><div><Badge variant="outline">{t('现状', 'Context')} v{snapshot.version}</Badge><strong>{snapshot.reason}</strong><time>{when(snapshot.createdAt)}</time></div><p className="goal-meta"><Source source={snapshot.source} /></p><HistoryDisclosure title={`${t('查看现状', 'View context')} v${snapshot.version} ${t('的快照', 'snapshot')}`}><p>{snapshot.summary || t('没有整体描述', 'No overall summary')}</p>{snapshot.entries.map(entry => <p key={entry.id}><span className="goal-meta">{goalEntryLabelsLocalized()[entry.kind]} · </span>{entry.text}</p>)}</HistoryDisclosure></article>)}{[...goal.definitions].reverse().map(definition => <article className="goal-history-row" key={`definition-${definition.version}`}><div><Badge variant="outline">{t('目标', 'Goal')} v{definition.version}</Badge><strong>{definition.reason}</strong><time>{when(definition.createdAt)}</time></div><HistoryDisclosure title={`${t('查看目标', 'View goal')} v${definition.version} ${t('的定义', 'definition')}`}><p>{definition.title}</p><p>{definition.expected || t('预期尚待澄清', 'Outcome needs clarification')}</p>{definition.criteria.map(criterion => <p key={criterion.id}>{criterion.text}</p>)}{definition.constraints && <p>{t('约束', 'Constraints')}: {definition.constraints}</p>}</HistoryDisclosure></article>)}</TabsContent>
        <TabsContent value="reviews" className="goal-scroll"><div className="goal-review-toolbar"><div><h2>{t('复盘与下一步', 'Reviews and next steps')}</h2><p className="goal-meta">{t('保留当时的目标定义、前后现状和判断依据。', 'Preserve the goal definition, context before and after, and evidence at the time.')}</p></div><div><Button variant="outline" size="sm" onClick={() => { const schedule = goal.reviewSchedule; open('schedule', { enabled: String(schedule?.enabled ?? false), weekday: String(schedule?.weekday ?? 1), hour: String(schedule?.hour ?? 9), timeZone: schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }) }}><CalendarClock size={14} />{goal.reviewSchedule?.enabled ? t('每周复盘已开启', 'Weekly review enabled') : t('设置周期', 'Set schedule')}</Button><Button size="sm" onClick={() => open('review', { judgement: 'unknown' })}><Plus size={13} />{t('记录复盘', 'Record review')}</Button></div></div>{goal.reviewSchedule?.enabled && <p className="goal-schedule-note">{t('每周', 'Every')} {getCurrentLanguage() === 'zh' ? ['日', '一', '二', '三', '四', '五', '六'][goal.reviewSchedule.weekday] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][goal.reviewSchedule.weekday]} {String(goal.reviewSchedule.hour).padStart(2, '0')}:00 · {goal.reviewSchedule.timeZone}. {t('应用运行时整理快照；重新打开时补记最近一期，进度判断由你确认。', 'The app saves snapshots while running and catches up on the latest missed one when reopened. You confirm the progress assessment.')}</p>}{!goal.reviews.length && <div className="goal-review-empty"><CalendarClock size={24} /><h3>{t('还没有复盘记录', 'No reviews yet')}</h3><p>{t('变化说明了什么？原计划还合适吗？下一步准备做什么？', 'What changed? Does the plan still fit? What comes next?')}</p></div>}{[...goal.reviews].reverse().map(review => <article className="goal-review" key={review.id}><div className="goal-section-title"><h2>{review.trigger === 'weekly' ? t('周期现状快照', 'Recurring context snapshot') : t('手动复盘', 'Manual review')}<Badge variant="outline">{reviewJudgementLabelsLocalized()[review.judgement]}</Badge></h2><time className="goal-meta">{when(review.createdAt)}</time></div><p className="goal-review-summary">{review.summary}</p><p className="goal-helper">{review.evidence || t('尚未记录判断依据。', 'No assessment evidence recorded.')}</p><div className="goal-meta">{t('目标', 'Goal')} v{review.definition.version} · {t('现状', 'Context')} v{review.beforeState.version} → v{review.afterState.version}{review.scheduledFor && ` · ${t('原定', 'Scheduled')} ${when(review.scheduledFor)}`}</div>{review.needsAssessment && <Button size="sm" variant="outline" className="goal-note" onClick={() => open('review', { judgement: 'unknown', summary: '', evidence: `${t('参考', 'See')} ${when(review.createdAt)} ${t('周期快照', 'recurring snapshot')};`, actions: '' })}>{t('补充进度判断', 'Add progress assessment')}</Button>}<HistoryDisclosure title={t('查看当时的目标与前后现状', 'View goal and context at the time')}><p><strong>{review.definition.title}</strong> · {review.definition.expected}</p><p>{t('复盘前', 'Before')}: {review.beforeState.summary || t('未填写整体描述', 'No overall summary')}</p>{review.beforeState.entries.map(entry => <p key={`before-${entry.id}`} className="goal-meta">{goalEntryLabelsLocalized()[entry.kind]}: {entry.text}</p>)}<p>{t('复盘后', 'After')}: {review.afterState.summary || t('未填写整体描述', 'No overall summary')}</p>{review.afterState.entries.map(entry => <p key={`after-${entry.id}`} className="goal-meta">{goalEntryLabelsLocalized()[entry.kind]}: {entry.text}</p>)}</HistoryDisclosure>{review.nextActions.length > 0 && <div className="goal-next-actions"><h3>{t('下一步行动', 'Next actions')}</h3>{review.nextActions.map((action, index) => <div key={index}><span>{action}</span><Button variant="outline" size="sm" onClick={() => onCreateTask(goal.id, action)}>{t('创建任务', 'Create task')} <ArrowRight size={12} /></Button></div>)}</div>}</article>)}</TabsContent>
      </Tabs>
    </main>}
    </GoalListLayout>
    <Dialog open={modal !== null} onOpenChange={isOpen => { if (!isOpen) { setModal(null); setError('') } }}><DialogContent className="goal-dialog" onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus() } }}><DialogHeader><DialogTitle>{modal ? modalTitles()[modal] : t('目标', 'Goal')}</DialogTitle><DialogDescription>{modal === 'create' ? t('先描述想做的事情，其他信息可以后续完善。', 'Describe what you want to do. You can fill in the details later.') : modal === 'state' ? t('事实、假设和未知分别记录。每次修订保留来源与旧版现状。', 'Record facts, hypotheses, and unknowns separately. Each revision preserves sources and prior context.') : modal === 'review' ? t('结合明确的预期和证据判断进展；信息不足时保留“暂无法判断”。', 'Assess progress against clear expectations and evidence. If information is insufficient, leave it undetermined.') : modal === 'schedule' ? t('周期检查保存事实快照，不会自动编造结论或启动任务。', 'Recurring checks save factual snapshots; they do not invent conclusions or start tasks.') : t('保存后保留历史依据，不改写已有执行中的快照。', 'Saving preserves historical evidence and does not rewrite active run snapshots.')}</DialogDescription></DialogHeader><form onSubmit={submit} className="goal-form">
      {(modal === 'create' || modal === 'edit') && <><Field label={t('目标名称', 'Goal name')} id="goal-title"><Input id="goal-title" autoFocus value={draft.title ?? ''} onChange={event => field('title', event.target.value)} placeholder={t('描述你希望推进的事情', 'Describe what you want to move forward')} /></Field><Field label={t('预期结果', 'Expected outcome')} id="goal-expected"><Textarea id="goal-expected" value={draft.expected ?? ''} onChange={event => field('expected', event.target.value)} placeholder={t('希望最终达到什么状态？', 'What would success look like?')} rows={2} /></Field><Field label={t('为什么做', 'Why it matters')} id="goal-intent"><Input id="goal-intent" value={draft.intent ?? ''} onChange={event => field('intent', event.target.value)} placeholder={t('可选，记录目标的背景', 'Optional background for this goal')} /></Field><Field label={t('成功条件', 'Success criteria')} id="goal-criteria" hint={t('每行一项，可以是可交付成果、能力验证、结论或指标。', 'One per line: a deliverable, capability check, conclusion, or metric.')}><Textarea id="goal-criteria" value={draft.criteria ?? ''} onChange={event => field('criteria', event.target.value)} rows={3} /></Field>{modal === 'create' && <Field label={t('期望日期（可选）', 'Target date (optional)')} id="goal-deadline"><Input id="goal-deadline" type="date" value={draft.deadline ?? ''} onChange={event => field('deadline', event.target.value)} /></Field>}{modal === 'create' ? <Field label={t('当前现状', 'Current context')} id="goal-summary"><Textarea id="goal-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={2} placeholder={t('可选：已知什么，还缺少什么？', 'Optional: What is known, and what is missing?')} /></Field> : <><Field label={t('范围与约束', 'Scope and constraints')} id="goal-constraints"><Textarea id="goal-constraints" value={draft.constraints ?? ''} onChange={event => field('constraints', event.target.value)} rows={2} /></Field><Field label={t('期望日期（可选）', 'Target date (optional)')} id="goal-deadline"><Input id="goal-deadline" type="date" value={draft.deadline ?? ''} onChange={event => field('deadline', event.target.value)} /></Field><Field label={t('本次修订原因', 'Reason for revision')} id="goal-reason"><Input id="goal-reason" value={draft.reason ?? ''} onChange={event => field('reason', event.target.value)} /></Field></>}</>}
      {modal === 'state' && <><Field label={t('整体描述', 'Overall summary')} id="goal-state-summary"><Textarea id="goal-state-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={3} /></Field><Field label={draft.entryId ? t('修订条目', 'Revise entry') : t('新增条目（可选）', 'New entry (optional)')} id="goal-state-text"><Textarea id="goal-state-text" value={draft.text ?? ''} onChange={event => field('text', event.target.value)} rows={3} placeholder={t('已有事实、成果、未知问题或查询方式', 'Known facts, artifacts, open questions, or how to investigate')} /></Field><div className="goal-form-pair"><Field label={t('内容类型', 'Entry type')} id="goal-entry-kind"><Choice label={t('内容类型', 'Entry type')} value={draft.kind ?? 'fact'} onChange={value => field('kind', value)} options={goalEntryLabelsLocalized()} /></Field><Field label={t('来源类型', 'Source type')} id="goal-source-kind"><Choice label={t('来源类型', 'Source type')} value={draft.sourceKind ?? 'user'} onChange={value => field('sourceKind', value)} options={{ user: t('用户提供', 'User provided'), file: t('文件 / 文档', 'File / document'), url: t('网页 / 资料', 'Web / reference'), tool: t('查询 / 工具', 'Query / tool'), task: t('任务结果', 'Task result') }} /></Field></div>{draft.kind === 'metric' && <><div className="goal-form-pair"><Field label={t('指标名称', 'Metric name')} id="goal-metric-name"><Input id="goal-metric-name" value={draft.metricName ?? ''} onChange={event => field('metricName', event.target.value)} /></Field><Field label={t('观测数值', 'Observed value')} id="goal-metric-value"><Input id="goal-metric-value" type="number" step="any" value={draft.metricValue ?? ''} onChange={event => field('metricValue', event.target.value)} /></Field></div><Field label={t('单位', 'Unit')} id="goal-metric-unit"><Input id="goal-metric-unit" value={draft.metricUnit ?? ''} onChange={event => field('metricUnit', event.target.value)} /></Field><Field label={t('统计口径与观察窗口', 'Definition and observation window')} id="goal-metric-definition"><Input id="goal-metric-definition" value={draft.metricDefinition ?? ''} onChange={event => field('metricDefinition', event.target.value)} /></Field></>}<Field label={t('来源说明', 'Source description')} id="goal-source"><Input id="goal-source" value={draft.sourceLabel ?? ''} onChange={event => field('sourceLabel', event.target.value)} /></Field><Field label={t('文件、链接或查询方式（可选）', 'File, link, or query (optional)')} id="goal-reference"><Input id="goal-reference" value={draft.reference ?? ''} onChange={event => field('reference', event.target.value)} /></Field><Field label={t('变化原因', 'Reason for change')} id="goal-state-reason"><Input id="goal-state-reason" value={draft.reason ?? ''} onChange={event => field('reason', event.target.value)} placeholder={t('什么发生了变化，依据是什么？', 'What changed, and what is the evidence?')} /></Field></>}
      {modal === 'criterion' && <><p className="goal-form-context">{modalCriterion?.text}</p>{(modalCriterion?.target || modalCriterion?.method || modalCriterion?.baseline) && <dl className="goal-criterion-definition">{modalCriterion.target && <div><dt>{t('达成标准', 'Success standard')}</dt><dd>{modalCriterion.target}</dd></div>}{modalCriterion.method && <div><dt>{t('检验方式', 'Verification method')}</dt><dd>{modalCriterion.method}</dd></div>}{modalCriterion.baseline && <div><dt>{t('当前基线', 'Current baseline')}</dt><dd>{modalCriterion.baseline}</dd></div>}</dl>}<Field label={t('检查结果', 'Review result')} id="goal-criterion-status"><Choice label={t('检查结果', 'Review result')} value={draft.status ?? 'unverified'} onChange={value => field('status', value)} options={criterionLabels()} /></Field><Field label={t('验收依据', 'Acceptance evidence')} id="goal-criterion-evidence" hint={t('可以记录验证方法、产物位置或用户确认；未验证时无需假定已通过。', 'Record a verification method, artifact, or user confirmation. Unverified does not imply success.')}><Textarea id="goal-criterion-evidence" value={draft.evidence ?? ''} onChange={event => field('evidence', event.target.value)} rows={4} /></Field></>}
      {modal === 'plan' && <><Field label={t('阶段名称', 'Stage name')} id="goal-stage-title"><Input id="goal-stage-title" value={draft.title ?? ''} onChange={event => field('title', event.target.value)} /></Field><Field label={t('推进方向与调整说明', 'Direction and changes')} id="goal-stage-description"><Textarea id="goal-stage-description" value={draft.description ?? ''} onChange={event => field('description', event.target.value)} rows={4} /></Field><Field label={t('阶段状态', 'Stage status')} id="goal-stage-status"><Choice label={t('阶段状态', 'Stage status')} value={draft.status ?? 'planned'} onChange={value => field('status', value)} options={stageLabels()} /></Field></>}
      {modal === 'review' && <><Field label={t('进度判断', 'Progress assessment')} id="goal-review-judgement"><Choice label={t('进度判断', 'Progress assessment')} value={draft.judgement ?? 'unknown'} onChange={value => field('judgement', value)} options={reviewJudgementLabelsLocalized()} /></Field><Field label={t('复盘结论', 'Review summary')} id="goal-review-summary"><Textarea id="goal-review-summary" value={draft.summary ?? ''} onChange={event => field('summary', event.target.value)} rows={3} placeholder={t('发生了什么变化？原计划是否仍然合理？', 'What changed? Does the plan still make sense?')} /></Field><Field label={t('预期标准与判断依据', 'Expected standard and evidence')} id="goal-review-evidence"><Textarea id="goal-review-evidence" value={draft.evidence ?? ''} onChange={event => field('evidence', event.target.value)} rows={3} /></Field><Field label={t('下一步行动', 'Next actions')} id="goal-review-actions" hint={t('每行一项，保存后可以分别转成任务。', 'One per line. Each can become a task after saving.')}><Textarea id="goal-review-actions" value={draft.actions ?? ''} onChange={event => field('actions', event.target.value)} rows={3} /></Field></>}
      {modal === 'schedule' && <><div className="goal-switch-row"><Label htmlFor="goal-schedule-enabled">{t('每周保存复盘快照', 'Save weekly review snapshots')}</Label><Switch id="goal-schedule-enabled" checked={draft.enabled === 'true'} onCheckedChange={checked => field('enabled', String(checked))} /></div><div className="goal-form-pair"><Field label={t('星期', 'Weekday')} id="goal-weekday"><Choice label={t('星期', 'Weekday')} value={draft.weekday ?? '1'} onChange={value => field('weekday', value)} options={{ '1': t('星期一', 'Monday'), '2': t('星期二', 'Tuesday'), '3': t('星期三', 'Wednesday'), '4': t('星期四', 'Thursday'), '5': t('星期五', 'Friday'), '6': t('星期六', 'Saturday'), '0': t('星期日', 'Sunday') }} /></Field><Field label={t('时间（整点）', 'Hour')} id="goal-hour"><Input id="goal-hour" type="number" min="0" max="23" value={draft.hour ?? '9'} onChange={event => field('hour', event.target.value)} /></Field></div><Field label={t('时区', 'Time zone')} id="goal-timezone"><Input id="goal-timezone" value={draft.timeZone ?? ''} onChange={event => field('timeZone', event.target.value)} /></Field><p className="goal-helper">{t('应用运行时执行；退出期间不会运行。再次打开会补记最近错过的一期，按目标和周期去重，并记录实际保存时间。需要你补充证据和判断。', 'Runs while the app is open. When reopened, it catches up on the latest missed snapshot, deduplicates by goal and period, and records the save time. You provide the evidence and assessment.')}</p></>}
      {modal === 'proposal' && proposal && <ProposalDetails proposal={proposal} currentVersion={modalGoal?.currentState.version ?? 0} />}
      {error && <p role="alert" className="goal-form-error">{error}</p>}<DialogFooter className="goal-dialog-footer"><Button type="button" variant="outline" onClick={() => setModal(null)}>{t('取消', 'Cancel')}</Button><Button type="submit" disabled={saving}>{saving ? t('保存中…', 'Saving…') : modal === 'create' ? t('创建目标', 'Create goal') : modal === 'proposal' ? proposal?.baseStateVersion !== modalGoal?.currentState.version ? t('已核对，重新生成建议', 'Reviewed; regenerate proposal') : t('采纳到现状', 'Apply to context') : t('保存', 'Save')}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </div>
}

function ProposalDetails({ proposal, currentVersion }: { proposal: GoalStateProposal; currentVersion: number }) {
  const { t } = useI18n()
  return <div className="goal-proposal-details"><p><strong>{proposal.title}</strong></p><p className="goal-meta">{proposal.source.label} · {t('基于现状', 'Based on context')} v{proposal.baseStateVersion} · {t('当前', 'Current')} v{currentVersion}</p>{proposal.entries.map(entry => <div className="goal-form-context" key={entry.id}><span className="goal-meta">{goalEntryLabelsLocalized()[entry.kind]}</span><p>{entry.text}</p><p className="goal-meta">{entry.source.label}{entry.source.reference && ` · ${entry.source.reference}`}</p></div>)}<p className="goal-helper">{t('采纳后将这些条目追加到现状，并保留来源；现有事实不会被覆盖。', 'Applying adds these entries to context and preserves their sources. Existing facts are not overwritten.')}</p>{proposal.baseStateVersion !== currentVersion && <p className="goal-form-error">{t('这条建议产生后现状已变化。请与当前现状核对，重新生成建议后再采纳。', 'Context changed after this proposal. Compare it with the current version and regenerate before applying.')}</p>}</div>
}

export default GoalsPage
