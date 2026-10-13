import { AnimatedNumber } from '@/components/ui/animated-number'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, CircleAlert, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { getRunActivity } from '@/lib/domain'
import { getGoalAssistantInvocations, getGoalAssistantRunResponse, type GoalAssistantTokenUsage } from '@/lib/goal-assistant-execution'
import type { Run, Task } from '@/lib/types'
import { useI18n } from '@/i18n'
import { MarkdownMessage } from './MarkdownMessage'
import { RuntimeLogo } from './RuntimeLogo'
import './goal-assistant-run-details.css'

const TracePanel = lazy(() => import('./TracePanel').then(module => ({ default: module.TracePanel })))
const noop = () => {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function TokenUsage({ usage, label }: { usage?: GoalAssistantTokenUsage; label: string }) {
  const { t } = useI18n()
  if (!usage) return <div className="goal-run-usage"><strong>{label}</strong><span>{t('Runtime 未提供', 'Not provided by runtime')}</span></div>
  const values: Array<[string, number | undefined]> = [[t('输入', 'Input'), usage.input], [t('缓存输入', 'Cached input'), usage.cachedInput], [t('输出', 'Output'), usage.output], [t('推理输出', 'Reasoning output'), usage.reasoningOutput], [t('合计', 'Total'), usage.total]]
  return <div className="goal-run-usage"><strong>{label}</strong>{values.filter(([, value]) => value !== undefined).map(([name, value]) => <span key={name}>{name} <code><AnimatedNumber value={value!} format={value => Math.round(value).toLocaleString()} animateUpdates={false} /></code></span>)}</div>
}

export function GoalAssistantRunDetails({ task, run, onStop, onPrepare, error }: { task: Task; run: Run; onStop?: () => Promise<void>; onPrepare?: (taskId: string) => Promise<void>; error?: string }) {
  const { t, language } = useI18n()
  const [open, setOpen] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [following, setFollowing] = useState(true)
  const responseArea = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const preparation = useRef('')
  const route = `${task.id}:${run.id}`
  const currentRoute = useRef(route)
  currentRoute.current = route
  const valid = task.kind === 'goal_assistant' && Boolean(task.goalId) && run.context?.goal?.id === task.goalId && task.runs.some(item => item.id === run.id)
  const active = run.members.some(member => member.status === 'running')
  // The elapsed clock does not reparse a growing native trace every second.
  const activity = useMemo(() => getRunActivity(task, run), [task.events, run, language])
  const invocations = useMemo(() => getGoalAssistantInvocations(task, run), [task.id, task.events, run, language])
  const response = useMemo(() => task.historyPending ? '' : getGoalAssistantRunResponse(task, run), [task.messages, task.historyPending, run])
  const first = invocations[0]
  const firstModel = first?.nativeModel || first?.member.model || first?.member.runtime.defaultModel
  const started = Date.parse(run.createdAt)
  const last = Date.parse(activity.lastEventAt ?? '')
  const elapsed = (active ? now : last) - started
  const failure = run.members.some(member => member.status === 'failed' || member.status === 'interrupted')

  useEffect(() => {
    setOpen(false); setOperationError(''); setStopping(false); setPreparing(false)
    follow.current = true; setFollowing(true); preparation.current = ''
  }, [task.id, run.id])
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, run.id])
  useEffect(() => {
    if (!valid || !task.historyPending || !onPrepare || preparation.current === task.id) return
    preparation.current = task.id
    let cancelled = false
    setPreparing(true)
    void onPrepare(task.id).catch(cause => { if (!cancelled) setOperationError(errorText(cause)) }).finally(() => { if (!cancelled) setPreparing(false) })
    return () => { cancelled = true }
  }, [valid, task.id, task.historyPending, onPrepare])
  useEffect(() => {
    if (open && follow.current && responseArea.current) responseArea.current.scrollTop = responseArea.current.scrollHeight
  }, [open, response])
  if (!valid) return null

  const unspecified = t('沿用 Runtime 默认（未提供实际值）', 'Runtime default (actual value not provided)')
  const stateLabel = task.historyPending ? t('正在恢复调用记录…', 'Restoring invocation history…') : stopping ? t('正在停止…', 'Stopping…') : activity.label
  const visibleError = operationError || error
  const Icon = failure ? CircleAlert : run.members.some(member => member.status === 'stopped') ? Square : CheckCircle2
  return <Collapsible open={open} onOpenChange={setOpen} className={'goal-assistant-run-details' + (failure ? ' goal-run-failed' : '')} aria-label={t('目标助手模型调用', 'Goal assistant model invocation')}>
    <div className="goal-run-summary">
      {active || task.historyPending ? <Spinner aria-hidden="true" role="presentation" /> : <Icon size={14} aria-hidden="true" />}
      <span className="goal-run-state" role="status" aria-live="polite">{stateLabel}</span>
      {first && <span className="goal-run-identity" title={`${first.member.runtime.name} · ${firstModel || unspecified}`}><RuntimeLogo runtime={first.member.runtime} size={14} /><span>{first.member.runtime.name} · {firstModel || t('Runtime 默认模型', 'Runtime default model')}</span></span>}
      {!task.historyPending && Number.isFinite(elapsed) && <time className="goal-run-elapsed" title={t('本次调用耗时', 'Elapsed time for this invocation')}><AnimatedNumber value={elapsed} format={duration} animateUpdates={false} /></time>}
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" aria-label={t('调用详情', 'Invocation details')}><CollapsibleIndicator size={14} />{t('调用详情', 'Invocation details')}</Button></CollapsibleTrigger>
      {active && onStop && <Button variant="outline" size="sm" disabled={stopping} aria-label={t('停止生成建议', 'Stop generating suggestions')} onClick={() => {
        if (stopping) return
        setStopping(true); setOperationError('')
        void onStop().catch(cause => { if (currentRoute.current === route) setOperationError(errorText(cause)) }).finally(() => { if (currentRoute.current === route) setStopping(false) })
      }}><Square size={12} />{t('停止', 'Stop')}</Button>}
    </div>
    {!task.historyPending && (activity.summary || response || activity.lastEventAt) && <div className="goal-run-activity">
      <span title={activity.summary}>{activity.summary || (response ? <>{t('已收到 ', '')}<AnimatedNumber value={Array.from(response).length} animateUpdates={false} />{t(' 字回复', ' response characters received')}</> : t('等待模型返回公开活动', 'Waiting for public model activity'))}</span>
      {activity.lastEventAt && <time title={t('最近公开活动', 'Latest public activity')}>{new Date(activity.lastEventAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</time>}
    </div>}
    {visibleError && <div className="goal-run-error" role="alert"><span>{visibleError}</span>{task.historyPending && onPrepare && <Button variant="outline" size="sm" disabled={preparing} onClick={() => {
      setPreparing(true); setOperationError('')
      void onPrepare(task.id).catch(cause => setOperationError(errorText(cause))).finally(() => setPreparing(false))
    }}>{t('重试加载', 'Retry loading')}</Button>}</div>}
    <CollapsibleContent unmountOnExit><div className="goal-run-detail-body">
      <dl className="goal-run-metadata"><dt>{t('执行 ID', 'Run ID')}</dt><dd><code>{run.id}</code></dd><dt>{t('开始时间', 'Started')}</dt><dd>{Number.isFinite(started) ? new Date(started).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : t('未记录', 'Not recorded')}</dd><dt>{t('目标 / 现状快照', 'Goal / context snapshot')}</dt><dd>v{run.context?.goal?.version} / v{run.context?.goal?.currentState.version}</dd><dt>{t('工作目录', 'Working directory')}</dt><dd><code>{run.directory}</code></dd></dl>
      {invocations.map(invocation => <div className="goal-run-invocation" key={invocation.member.id}>
        <dl className="goal-run-metadata"><dt>Runtime</dt><dd>{invocation.member.runtime.name}<code>{invocation.member.runtime.executable}</code></dd><dt>{t('请求模型', 'Requested model')}</dt><dd>{invocation.member.model || invocation.member.runtime.defaultModel || unspecified}</dd><dt>{t('本轮思考强度', 'Requested turn reasoning')}</dt><dd>{invocation.member.effectiveReasoningEffort && invocation.member.effectiveReasoningEffort !== 'inherit' ? invocation.member.effectiveReasoningEffort : unspecified}</dd><dt>{t('运行状态', 'Run status')}</dt><dd>{invocation.member.status}</dd>
          {invocation.nativeModel && <><dt>{t('Runtime 确认模型', 'Runtime-confirmed model')}</dt><dd>{invocation.nativeModel}</dd></>}
          {invocation.nativeProvider && <><dt>{t('Runtime 确认供应商', 'Runtime-confirmed provider')}</dt><dd>{invocation.nativeProvider}</dd></>}
          {invocation.nativeSessionReasoning && <><dt>{t('会话默认思考强度', 'Session default reasoning')}</dt><dd>{invocation.nativeSessionReasoning}</dd></>}
          <dt>{t('会话 ID', 'Session ID')}</dt><dd><code>{invocation.threadId || t('尚未提供', 'Not provided yet')}</code></dd>{invocation.turnId && <><dt>{t('轮次 ID', 'Turn ID')}</dt><dd><code>{invocation.turnId}</code></dd></>}
        </dl>
        <TokenUsage usage={invocation.latestUsage} label={t('最近一次 token 用量', 'Latest reported token usage')} />
        {invocation.conversationUsage && <TokenUsage usage={invocation.conversationUsage} label={t('会话累计 token 用量', 'Conversation cumulative token usage')} />}
        {invocation.modelContextWindow !== undefined && <p className="goal-run-context-window">{t('模型上下文窗口', 'Model context window')} <code><AnimatedNumber value={invocation.modelContextWindow} format={value => Math.round(value).toLocaleString()} /></code></p>}
      </div>)}
      <Collapsible className="goal-run-instructions"><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><CollapsibleIndicator size={14} />{t('本轮指令（应用记录）', 'This-turn instructions (app record)')}</Button></CollapsibleTrigger><CollapsibleContent unmountOnExit><pre tabIndex={0} aria-label={t('本轮指令（应用记录）', 'This-turn instructions (app record)')}>{run.prompt}</pre></CollapsibleContent></Collapsible>
      <div className="goal-run-response-heading"><strong>{t('实时回复', 'Live response')}</strong>{!following && <Button variant="ghost" size="sm" onClick={() => { follow.current = true; setFollowing(true); if (responseArea.current) responseArea.current.scrollTop = responseArea.current.scrollHeight }}><ArrowDown size={13} />{t('回到最新', 'Jump to latest')}</Button>}</div>
      <div className="goal-run-response" aria-label={t('本轮模型回复', 'Model response for this turn')} ref={responseArea} tabIndex={0} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 48; setFollowing(follow.current) }}>{response ? <MarkdownMessage text={response} /> : <p className="goal-run-empty">{task.historyPending ? t('正在恢复调用记录…', 'Restoring invocation history…') : active ? t('等待模型返回正文…', 'Waiting for model response…') : t('本轮没有可读回复。', 'No readable response for this turn.')}</p>}</div>
      <div className="goal-run-trace"><Suspense fallback={<div className="goal-run-trace-loading"><Spinner />{t('加载执行过程…', 'Loading run activity…')}</div>}><TracePanel task={task} run={run} embedded onClose={noop} onExport={noop} /></Suspense></div>
    </div></CollapsibleContent>
  </Collapsible>
}
