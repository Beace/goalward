import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, Check, ListChecks, Plus, RefreshCw, Square, X } from 'lucide-react'
import type { AppState } from '@/lib/types'
import type { Goal, GoalAssistantDraft, GoalTaskProposal } from '@/lib/goal-types'
import { adoptGoalTaskProposal, adoptGoalTaskProposals, dismissGoalTaskProposal, rollbackGoalAssistantAction } from '@/lib/goal-assistant'
import type { GoalAssistantDraftSource } from '@/lib/goal-assistant'
import { isDesktop } from '@/lib/bridge'
import { canConfigureTask } from '@/lib/onboarding'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { MarkdownMessage } from './MarkdownMessage'
import { RuntimeApprovalPanel } from './RuntimeApprovalPanel'
import { RuntimeLogo } from './RuntimeLogo'
import { useI18n } from '@/i18n'
import './goal-assistant.css'

type Change = (reducer: (state: AppState) => AppState) => Promise<void>
/** useAppState projects writes optimistically; failed confirmations cannot authorize a next step. */
export async function persistGoalAssistantAction(onChange: Change, reducer: (state: AppState) => AppState) {
  let before: AppState | undefined, applied: AppState | undefined
  try { await onChange(previous => { before = previous; applied = reducer(previous); return applied }) }
  catch (cause) {
    if (before && applied && before !== applied) {
      const original = before, failed = applied
      await onChange(current => rollbackGoalAssistantAction(current, original, failed)).catch(() => {})
    }
    throw cause
  }
}
export interface GoalAssistantProps {
  state: AppState
  goal?: Goal
  onChange: Change
  onStart: (idea: string, runtimeId?: string) => Promise<void>
  onSend?: (goalId: string, input: string, phase: 'clarify' | 'plan', runtimeId?: string) => Promise<void>
  onStop?: (goalId: string) => Promise<void>
  onPrepare?: (taskId: string) => Promise<void>
  onSettings?: () => void
  onConfirm: (draft: GoalAssistantDraft, runtimeId: string | undefined, source: GoalAssistantDraftSource) => Promise<void>
}
const draftFromGoal = (goal: Goal): GoalAssistantDraft => ({ title: goal.title, intent: goal.intent, expected: goal.expected, constraints: goal.constraints, deadline: goal.deadline, currentSummary: goal.currentState.summary, criteria: goal.criteria.map(item => ({ text: item.text, baseline: item.baseline ?? '', target: item.target ?? '', method: item.method ?? '' })) })

/** Goal conversation uses its own execution Task; it never reads a business Task's chat. */
export function GoalAssistant({ state, goal, onChange, onStart, onSend, onStop, onPrepare, onSettings, onConfirm }: GoalAssistantProps) {
  const { t } = useI18n()
  const task = goal ? state.tasks.find(item => item.id === goal.assistant?.taskId && item.kind === 'goal_assistant' && item.goalId === goal.id) : undefined
  const latestRun = task?.runs.at(-1)
  const running = Boolean(task?.runs.some(run => run.members.some(member => member.status === 'running')))
  const eligible = state.settings.runtimes.filter(canConfigureTask)
  const [runtimeId, setRuntimeId] = useState(eligible.some(item => item.id === state.settings.defaultRuntime) ? state.settings.defaultRuntime : eligible[0]?.id ?? '')
  const selectedRuntime = eligible.find(item => item.id === runtimeId) ?? eligible[0]
  const [input, setInput] = useState(goal?.assistant?.input ?? state.goalExplorationInput ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const action = useRef(false)
  const transcript = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const draft = goal?.assistant?.draft ?? (goal ? draftFromGoal(goal) : undefined)
  const draftSource: GoalAssistantDraftSource | undefined = goal ? {
    goalVersion: goal.assistant?.draft ? goal.assistant.draftGoalVersion ?? goal.version : goal.version,
    stateVersion: goal.assistant?.draft ? goal.assistant.draftStateVersion ?? goal.currentState.version : goal.currentState.version,
  } : undefined
  const historyPending = Boolean(task?.historyPending)
  const latestStatus = latestRun?.members.find(member => member.status === 'failed' || member.status === 'interrupted' || member.status === 'stopped')?.status

  useEffect(() => { setInput(goal?.assistant?.input ?? state.goalExplorationInput ?? ''); setError(''); follow.current = true }, [goal?.id]) // Drafts are scoped to the Goal.
  useEffect(() => { if (task?.historyPending && onPrepare) void onPrepare(task.id).catch(cause => setError(String(cause instanceof Error ? cause.message : cause))) }, [task?.id, task?.historyPending, onPrepare])
  useEffect(() => { if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight }, [task?.messages])
  const commitDraft = async (next: GoalAssistantDraft) => {
    if (!goal || !draftSource) return
    const source = draftSource
    try { await onChange(previous => {
      const current = previous.goals.find(item => item.id === goal.id)
      if (!current || current.version !== source.goalVersion || current.currentState.version !== source.stateVersion) throw new Error(t('目标或现状已更新，请核对最新草案后修改。', 'The goal or context changed. Review the latest draft before editing.'))
      return { ...previous, goals: previous.goals.map(item => item.id === goal.id ? { ...item, assistant: { ...item.assistant, draft: next, draftGoalVersion: source.goalVersion, draftStateVersion: source.stateVersion } } : item) }
    }) }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)) }
  }
  const setDraftField = (name: Exclude<keyof GoalAssistantDraft, 'criteria'>, value: string) => { if (draft) void commitDraft({ ...draft, [name]: value }) }
  const changeInput = (value: string) => {
    setInput(value)
    if (goal) void onChange(previous => ({ ...previous, goals: previous.goals.map(item => item.id === goal.id ? { ...item, assistant: { ...item.assistant, input: value } } : item) })).catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
    else void onChange(previous => ({ ...previous, goalExplorationInput: value })).catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
  }
  async function perform(work: () => Promise<void>) {
    if (action.current) return
    action.current = true; setBusy(true); setError('')
    try { await work() } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)) }
    finally { action.current = false; setBusy(false) }
  }
  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    const prompt = input.trim()
    if (!prompt || running || historyPending) return
    await perform(async () => {
      if (goal) {
        if (!isDesktop || !onSend || !selectedRuntime) throw new Error(t('请在桌面应用中配置 Runtime 后发送；也可直接手动整理目标。', 'Configure a runtime in the desktop app to send, or organize the goal manually.'))
        await onSend(goal.id, prompt, 'clarify', selectedRuntime.id)
        setInput(current => current.trim() === prompt ? '' : current)
        await onChange(previous => ({ ...previous, goals: previous.goals.map(item => item.id === goal.id && item.assistant?.input?.trim() === prompt ? { ...item, assistant: { ...item.assistant, input: '' } } : item) }))
      } else { await onStart(prompt, selectedRuntime?.id); setInput('') }
    })
  }
  const canSend = Boolean(!goal || (isDesktop && onSend && selectedRuntime))
  const visibleMessages = task?.messages.filter(message => message.kind !== 'reasoning' && message.role !== 'system') ?? []
  return <div className={`goal-assistant${!goal ? ' goal-assistant-start' : ''}`}>
    <div className="goal-assistant-conversation">
      <div className="goal-assistant-transcript" ref={transcript} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 56 }}>
        {!goal ? <div className="goal-assistant-intro"><h1>{t('开始一件事', 'Start something')}</h1><p>{t('先说说你想推进的事情。目标助手会和你一起明确结果、成功条件与下一步。', 'Describe what you want to move forward. The goal assistant will help clarify the outcome, success criteria, and next steps.')}</p></div> : !visibleMessages.length ? <div className="goal-assistant-intro"><h2>{t('目标助手', 'Goal assistant')}</h2><p>{t('哪里还不明确？可以描述现状、补充材料，或告诉助手你的约束。', 'What is still unclear? Describe the context, add references, or explain your constraints.')}</p></div> : visibleMessages.map(message => <article className={`goal-assistant-message goal-assistant-message-${message.role}`} key={message.id}><div className="goal-assistant-message-label">{message.role === 'user' ? t('你', 'You') : t('目标助手', 'Goal assistant')}</div><MarkdownMessage text={message.role === 'assistant' ? message.text.replace(/^```goalward[ \t]*\r?\n[\s\S]*$/m, '').trim() : message.text} /></article>)}
        {historyPending && <p role="status" className="goal-meta">{t('正在恢复目标助手的历史…', 'Restoring assistant history…')}</p>}
      </div>
      {task && <RuntimeApprovalPanel task={task} />}
      <form className="goal-assistant-composer" onSubmit={event => void send(event)}>
        <Textarea aria-label={t('给目标助手的消息', 'Message to goal assistant')} placeholder={goal ? t('补充想法或约束…', 'Add ideas or constraints…') : t('我想…', 'I want to…')} value={input} onChange={event => changeInput(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} rows={3} />
        <div className="goal-assistant-composer-tools"><div className="goal-assistant-runtime"><Select value={selectedRuntime?.id ?? '__none__'} onValueChange={setRuntimeId} disabled={busy || running || !eligible.length}><SelectTrigger aria-label={t('目标助手 Runtime', 'Goal assistant runtime')}><SelectValue /></SelectTrigger><SelectContent>{!eligible.length && <SelectItem value="__none__">{t('待配置 Runtime', 'Configure runtime')}</SelectItem>}{eligible.map(runtime => <SelectItem key={runtime.id} value={runtime.id}><span className="inline-flex items-center gap-2"><RuntimeLogo runtime={runtime} size={14} />{runtime.name}</span></SelectItem>)}</SelectContent></Select><span className="goal-meta">{selectedRuntime?.defaultModel || t('Runtime 默认模型', 'Runtime default model')}</span></div>{onSettings && <Button type="button" size="sm" variant="ghost" onClick={onSettings}>{t('配置', 'Settings')}</Button>}{running && onStop ? <Button type="button" size="icon-sm" aria-label={t('停止目标助手', 'Stop goal assistant')} disabled={busy} onClick={() => goal && void perform(() => onStop(goal.id))}><Square size={13} /></Button> : <Button type="submit" size="icon-sm" aria-label={!goal ? t('开始整理目标', 'Start clarifying goal') : t('发送给目标助手', 'Send to goal assistant')} disabled={busy || running || historyPending || !input.trim() || !canSend}><ArrowUp size={15} /></Button>}</div>
        {!isDesktop && <p className="goal-meta">{t('浏览器预览可手动整理；真实对话请在桌面应用运行。', 'Organize manually in browser preview. Real conversations run in the desktop app.')}</p>}
        {running && <p className="goal-meta" role="status">{t('目标助手正在处理…', 'Goal assistant is working…')}</p>}
        {latestStatus && !running && <div className="goal-assistant-error" role="status"><span>{latestStatus === 'failed' ? t('上次运行失败，输入与已有目标已保留。', 'The last run failed. Your input and goal are preserved.') : t('上次运行已停止，可以继续对话。', 'The last run stopped. You can continue the conversation.')}</span>{isDesktop && onSend && selectedRuntime && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => goal && void perform(() => onSend(goal.id, [...(task?.messages ?? [])].reverse().find(message => message.role === 'user')?.text || input, goal.assistant?.requestPhase ?? 'clarify', selectedRuntime.id))}><RefreshCw size={12} />{t('重试', 'Retry')}</Button>}</div>}
        {(error || goal?.assistant?.error) && <p className="goal-form-error" role="alert">{error || goal?.assistant?.error}</p>}{error && historyPending && onPrepare && task && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void perform(() => onPrepare(task.id))}>{t('重试恢复历史', 'Retry restoring history')}</Button>}
      </form>
    </div>
    {goal && draft && <aside className="goal-assistant-draft" aria-label={t('待确认目标', 'Goal to confirm')}><header><h2>{goal.assistant?.confirmedVersion ? t('目标草稿', 'Goal draft') : t('逐步明确目标', 'Clarify the goal')}</h2><Badge variant="outline">{t('可手动修改', 'Editable')}</Badge></header><div className="goal-assistant-draft-fields"><Label htmlFor={`assistant-title-${goal.id}`}>{t('目标名称', 'Goal name')}</Label><Input id={`assistant-title-${goal.id}`} value={draft.title} onChange={event => setDraftField('title', event.target.value)} /><Label htmlFor={`assistant-expected-${goal.id}`}>{t('预期结果', 'Expected outcome')}</Label><Textarea id={`assistant-expected-${goal.id}`} rows={3} value={draft.expected} onChange={event => setDraftField('expected', event.target.value)} /><Label htmlFor={`assistant-deadline-${goal.id}`}>{t('期望日期（可选）', 'Target date (optional)')}</Label><Input type="date" id={`assistant-deadline-${goal.id}`} value={draft.deadline} onChange={event => setDraftField('deadline', event.target.value)} /><div className="goal-assistant-criteria-heading"><Label>{t('成功条件与检验方法', 'Success criteria and verification')}</Label><Button type="button" size="icon-sm" variant="ghost" aria-label={t('增加成功条件', 'Add success criterion')} onClick={() => void commitDraft({ ...draft, criteria: [...draft.criteria, { text: '', baseline: '', target: '', method: '' }] })}><Plus size={13} /></Button></div>{draft.criteria.map((criterion, index) => <div className="goal-assistant-criterion-edit" key={index}><div><Input aria-label={t(`成功条件 ${index + 1}`, `Success criterion ${index + 1}`)} placeholder={t('成果、能力或指标的明确标准', 'A clear deliverable, capability, or metric standard')} value={criterion.text} onChange={event => void commitDraft({ ...draft, criteria: draft.criteria.map((item, i) => i === index ? { ...item, text: event.target.value } : item) })} /><Button type="button" size="icon-sm" variant="ghost" aria-label={t(`移除成功条件 ${index + 1}`, `Remove criterion ${index + 1}`)} onClick={() => void commitDraft({ ...draft, criteria: draft.criteria.filter((_, i) => i !== index) })}><X size={13} /></Button></div><Input aria-label={t(`检验方法 ${index + 1}`, `Verification method ${index + 1}`)} placeholder={t('如何检查、依据在哪里', 'How to verify and where to find evidence')} value={criterion.method} onChange={event => void commitDraft({ ...draft, criteria: draft.criteria.map((item, i) => i === index ? { ...item, method: event.target.value } : item) })} /><Input aria-label={t(`达成标准 ${index + 1}`, `Success standard ${index + 1}`)} placeholder={t('明确的达成标准，可为文字或数值', 'A concrete success standard, in words or numbers')} value={criterion.target} onChange={event => void commitDraft({ ...draft, criteria: draft.criteria.map((item, i) => i === index ? { ...item, target: event.target.value } : item) })} /><Collapsible><CollapsibleTrigger className="goal-disclosure"><CollapsibleIndicator size={12} />{t('当前基线（可选）', 'Current baseline (optional)')}</CollapsibleTrigger><CollapsibleContent><div className="goal-form-pair"><Input aria-label={t(`基线 ${index + 1}`, `Baseline ${index + 1}`)} placeholder={t('当前基线', 'Baseline')} value={criterion.baseline} onChange={event => void commitDraft({ ...draft, criteria: draft.criteria.map((item, i) => i === index ? { ...item, baseline: event.target.value } : item) })} /></div></CollapsibleContent></Collapsible></div>)}{!draft.criteria.length && <p className="goal-meta">{t('至少写一个可检验的成功条件。无需强行使用数字。', 'Add at least one verifiable criterion. Numbers are optional.')}</p>}<Label htmlFor={`assistant-constraints-${goal.id}`}>{t('范围与约束', 'Scope and constraints')}</Label><Textarea id={`assistant-constraints-${goal.id}`} rows={2} value={draft.constraints} onChange={event => setDraftField('constraints', event.target.value)} /><Label htmlFor={`assistant-context-${goal.id}`}>{t('当前现状', 'Current context')}</Label><Textarea id={`assistant-context-${goal.id}`} rows={2} value={draft.currentSummary} onChange={event => setDraftField('currentSummary', event.target.value)} /></div><footer><Button disabled={busy || running || historyPending} onClick={() => void perform(() => onConfirm(draft, selectedRuntime?.id, draftSource!))}><Check size={14} />{t('确认目标并安排任务', 'Confirm goal and plan tasks')}</Button><p className="goal-meta">{t('先保存目标，再提议任务。采用后才加入任务列表。', 'Save the goal first, then propose tasks. Only adopted proposals become tasks.')}</p></footer></aside>}
  </div>
}

export function GoalTaskProposals({ state, goal, onChange, onCreateTask, onOpenTask, onRetry }: { state: AppState; goal: Goal; onChange: Change; onCreateTask: () => void; onOpenTask: (id: string) => void; onRetry?: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const proposals = goal.assistant?.proposals ?? []
  const pending = proposals.filter(item => item.status === 'suggested')
  const task = state.tasks.find(item => item.id === goal.assistant?.taskId && item.kind === 'goal_assistant' && item.goalId === goal.id)
  const running = Boolean(task?.runs.some(run => run.members.some(member => member.status === 'running')))
  async function perform(action: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await action() } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)) } finally { lock.current = false; setBusy(false) } }
  const change = (proposal: GoalTaskProposal, field: 'title' | 'delivery' | 'acceptance' | 'deadline', value: string) => void onChange(previous => ({ ...previous, goals: previous.goals.map(item => item.id === goal.id ? { ...item, assistant: { ...item.assistant, proposals: item.assistant?.proposals?.map(p => p.id === proposal.id ? { ...p, [field]: value, edited: true } : p) } } : item) })).catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
  const dependencies = (proposal: GoalTaskProposal, dependencyId: string, checked: boolean) => void onChange(previous => ({ ...previous, goals: previous.goals.map(item => item.id === goal.id ? { ...item, assistant: { ...item.assistant, proposals: item.assistant?.proposals?.map(p => p.id === proposal.id ? { ...p, edited: true, dependsOn: checked ? [...new Set([...p.dependsOn, dependencyId])] : p.dependsOn.filter(id => id !== dependencyId) } : p) } } : item) })).catch(cause => setError(String(cause instanceof Error ? cause.message : cause)))
  return <section className="goal-task-proposals" aria-label={t('下一步任务建议', 'Suggested next tasks')}><div className="goal-section-title"><h2><ListChecks size={15} />{t('下一步任务建议', 'Suggested next tasks')}</h2><div className="goal-proposal-toolbar">{onRetry && <Button variant="ghost" size="sm" disabled={busy || running} onClick={() => void perform(onRetry)}><RefreshCw size={13} />{t('重新提议', 'Propose again')}</Button>}{pending.length > 0 && <Button size="sm" disabled={busy || running} onClick={() => void perform(() => persistGoalAssistantAction(onChange, previous => adoptGoalTaskProposals(previous, goal.id)))}>{t('采用全部', 'Adopt all')} {pending.length}</Button>}<Button variant="outline" size="sm" onClick={onCreateTask}><Plus size={13} />{t('手动补充', 'Add manually')}</Button></div></div>{running && <p role="status" className="goal-helper">{t('目标已保存，正在整理任务建议…', 'Goal saved. Preparing task proposals…')}</p>}{!proposals.length && !running && <p className="goal-empty-copy">{t('暂时没有任务建议，可以重试提议或手动补充。', 'No task proposals yet. Retry or add a task manually.')}</p>}{proposals.filter(item => item.status !== 'dismissed').map(proposal => <div className="goal-task-proposal-row" key={proposal.id}><div className="goal-task-proposal-main"><Input aria-label={t(`任务建议名称：${proposal.id}`, `Proposal title: ${proposal.id}`)} value={proposal.title} disabled={proposal.status === 'adopted'} onChange={event => change(proposal, 'title', event.target.value)} /><div className="goal-task-proposal-actions">{proposal.status === 'adopted' ? <><Badge variant="outline">{t('已采用', 'Adopted')}</Badge>{proposal.taskId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpenTask(proposal.taskId!)}>{t('打开任务', 'Open task')}</Button>}</> : <><Button size="icon-sm" variant="ghost" aria-label={t(`不采纳：${proposal.title}`, `Dismiss: ${proposal.title}`)} disabled={busy || running} onClick={() => void perform(() => persistGoalAssistantAction(onChange, previous => dismissGoalTaskProposal(previous, goal.id, proposal.id)))}><X size={13} /></Button><Button size="sm" disabled={busy || running} onClick={() => void perform(() => persistGoalAssistantAction(onChange, previous => adoptGoalTaskProposal(previous, goal.id, proposal.id)))}>{t('采用', 'Adopt')}</Button></>}</div></div><Collapsible><CollapsibleTrigger className="goal-disclosure"><CollapsibleIndicator size={12} />{t('交付、验收与依赖', 'Delivery, acceptance, and dependencies')}{proposal.deadline && ` · ${proposal.deadline}`}{proposal.dependsOn.length > 0 && ` · ${proposal.dependsOn.length} ${t('项依赖', 'dependencies')}`}</CollapsibleTrigger><CollapsibleContent><div className="goal-task-proposal-detail"><Label>{t('交付结果', 'Deliverable')}<Textarea aria-label={t(`交付结果：${proposal.id}`, `Deliverable: ${proposal.id}`)} rows={2} value={proposal.delivery} disabled={proposal.status === 'adopted'} onChange={event => change(proposal, 'delivery', event.target.value)} /></Label><Label>{t('验收要求', 'Acceptance')}<Textarea aria-label={t(`验收要求：${proposal.id}`, `Acceptance: ${proposal.id}`)} rows={2} value={proposal.acceptance} disabled={proposal.status === 'adopted'} onChange={event => change(proposal, 'acceptance', event.target.value)} /></Label><Label>{t('期望日期（可选）', 'Target date (optional)')}<Input type="date" aria-label={t(`任务期望日期：${proposal.id}`, `Proposal deadline: ${proposal.id}`)} value={proposal.deadline} disabled={proposal.status === 'adopted'} onChange={event => change(proposal, 'deadline', event.target.value)} /></Label>{proposal.status === 'suggested' && proposals.filter(item => item.id !== proposal.id && (item.status !== 'dismissed' || proposal.dependsOn.includes(item.id))).map(dependency => <Label className="goal-proposal-dependency" key={dependency.id}><Checkbox aria-label={t(`依赖：${proposal.title} → ${dependency.title}`, `Dependency: ${proposal.title} → ${dependency.title}`)} checked={proposal.dependsOn.includes(dependency.id)} onCheckedChange={checked => dependencies(proposal, dependency.id, checked === true)} />{dependency.title}</Label>)}{proposal.dependsOn.length > 0 && <p className="goal-meta">{t('依赖', 'Depends on')}: {proposal.dependsOn.map(id => proposals.find(item => item.id === id)?.title ?? id).join(' · ')}</p>}</div></CollapsibleContent></Collapsible></div>)}{(error || goal.assistant?.error) && <p className="goal-form-error" role="alert">{error || goal.assistant?.error}</p>}</section>
}
