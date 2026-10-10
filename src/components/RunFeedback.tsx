import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleX, Clock3, LoaderCircle, MessageSquare, Search, Square, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getRunActivity } from '@/lib/domain'
import type { Run, Task } from '@/lib/types'
import { RuntimeLogo } from './RuntimeLogo'
import { useI18n } from '@/i18n'

type Activity = ReturnType<typeof getRunActivity>

function ActivityIcon({ phase }: { phase: Activity['phase'] }) {
  const Icon = phase === 'web-search' ? Search : phase === 'tool' ? Terminal : phase === 'responding' ? MessageSquare : phase === 'completed' ? CheckCircle2 : phase === 'failed' ? CircleX : phase === 'stopped' ? Square : phase === 'interrupted' ? CircleAlert : phase === 'waiting' ? Clock3 : LoaderCircle
  return <Icon size={14} aria-hidden="true" className={phase === 'starting' ? 'animate-spin motion-reduce:animate-none' : ''} />
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function RunFeedback({ task, run, onStop, onInspector }: { task: Task; run: Run; onStop?: () => void; onInspector: () => void }) {
  const { t } = useI18n()
  const active = run.members.some(member => member.status === 'running')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, run.id])
  const activity = getRunActivity(task, run)
  const lastEvent = activity.lastEventAt ? Date.parse(activity.lastEventAt) : NaN
  const started = Date.parse(run.createdAt)
  const elapsed = (active ? now : lastEvent) - started
  const idleFor = now - lastEvent
  const owner = run.members.find(member => member.id === activity.memberId)
  return <div className={'run-feedback phase-' + activity.phase} aria-label={t('当前执行状态', 'Current run status')}>
    <ActivityIcon phase={activity.phase} />
    <div className="run-feedback-copy"><span className="run-feedback-title" role="status" aria-live="polite">{activity.label}{owner && run.members.length > 1 ? ` · ${owner.role}` : ''}</span>{activity.summary && <span className="run-feedback-summary" title={activity.summary}>{activity.summary}</span>}</div>
    {Number.isFinite(elapsed) && <time className="run-elapsed" title={t('从本次执行开始到当前或终止事件的时间', 'Time since this run started, until now or its final event')}>{duration(elapsed)}</time>}
    {active && Number.isFinite(idleFor) && idleFor >= 15000 && <span className="run-last-event" title={t('最近一次 Runtime 事件距今的时间', 'Time since the most recent runtime event')}>{t(`最近事件 ${duration(idleFor)} 前`, `Last event ${duration(idleFor)} ago`)}</span>}
    {active && onStop ? <Button variant="outline" size="sm" onClick={onStop} aria-label={t('停止当前执行', 'Stop current run')}><Square size={11} />{t('停止', 'Stop')}</Button> : <Button variant="ghost" size="sm" onClick={onInspector}>{t('查看执行', 'View run')}</Button>}
  </div>
}

export function RunActivityList({ task, run, memberId, onInspector }: { task: Task; run: Run; memberId?: string; onInspector: () => void }) {
  const { t, language } = useI18n()
  const members = memberId ? run.members.filter(member => member.id === memberId) : run.members
  return <div className="run-activity-list" aria-label={t('实时执行活动', 'Live run activity')}>{members.map(member => {
    const activity = getRunActivity(task, run, member.id)
    return <div key={member.id} className={'run-activity-row phase-' + activity.phase}>
      <div className="run-activity-avatar"><RuntimeLogo runtime={member.runtime} size={16} /></div>
      <div className="run-activity-content"><div className="run-activity-heading"><strong>{member.role}</strong><ActivityIcon phase={activity.phase} /><span>{activity.label}</span>{activity.lastEventAt && <time>{new Date(activity.lastEventAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })}</time>}</div>{activity.summary && <p>{activity.summary}</p>}</div>
      <Button variant="ghost" size="icon-sm" aria-label={`${t('查看', 'View')} ${member.role} ${t('的执行过程', 'run details')}`} title={t('查看完整执行过程', 'View full run details')} onClick={onInspector}><Terminal size={13} /></Button>
    </div>
  })}</div>
}
