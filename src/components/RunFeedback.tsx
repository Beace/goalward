import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleX, Clock3, LoaderCircle, MessageSquare, Search, Square, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getRunActivity } from '@/lib/domain'
import type { Run, Task } from '@/lib/types'
import { RuntimeLogo } from './RuntimeLogo'

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
  return <div className={'run-feedback phase-' + activity.phase} aria-label="当前执行状态">
    <ActivityIcon phase={activity.phase} />
    <div className="run-feedback-copy"><span className="run-feedback-title" role="status" aria-live="polite">{activity.label}{owner && run.members.length > 1 ? ` · ${owner.role}` : ''}</span>{activity.summary && <span className="run-feedback-summary" title={activity.summary}>{activity.summary}</span>}</div>
    {Number.isFinite(elapsed) && <time className="run-elapsed" title="从本次执行开始到当前或终止事件的时间">{duration(elapsed)}</time>}
    {active && Number.isFinite(idleFor) && idleFor >= 15000 && <span className="run-last-event" title="最近一次 Runtime 事件距今的时间">最近事件 {duration(idleFor)} 前</span>}
    {active && onStop ? <Button variant="outline" size="sm" onClick={onStop} aria-label="停止当前执行"><Square size={11} />停止</Button> : <Button variant="ghost" size="sm" onClick={onInspector}>查看执行</Button>}
  </div>
}

export function RunActivityList({ task, run, memberId, onInspector }: { task: Task; run: Run; memberId?: string; onInspector: () => void }) {
  const members = memberId ? run.members.filter(member => member.id === memberId) : run.members
  return <div className="run-activity-list" aria-label="实时执行活动">{members.map(member => {
    const activity = getRunActivity(task, run, member.id)
    return <div key={member.id} className={'run-activity-row phase-' + activity.phase}>
      <div className="run-activity-avatar"><RuntimeLogo runtime={member.runtime} size={16} /></div>
      <div className="run-activity-content"><div className="run-activity-heading"><strong>{member.role}</strong><ActivityIcon phase={activity.phase} /><span>{activity.label}</span>{activity.lastEventAt && <time>{new Date(activity.lastEventAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>}</div>{activity.summary && <p>{activity.summary}</p>}</div>
      <Button variant="ghost" size="icon-sm" aria-label={`查看${member.role}的执行过程`} title="查看完整执行过程" onClick={onInspector}><Terminal size={13} /></Button>
    </div>
  })}</div>
}
