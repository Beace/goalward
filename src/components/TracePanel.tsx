import { memo, useEffect, useId, useMemo, useState } from 'react'
import { Activity, ArrowDownLeft, ArrowUpRight, Brain, Check, CircleAlert, Clock3, Copy, Download, FileDiff, Globe, ListFilter, LoaderCircle, MessageSquare, Play, Radio, Terminal, Wrench, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { VirtualList } from '@/components/ui/virtual-list'
import { Status } from './Status'
import { RuntimeLogo } from './RuntimeLogo'
import { TracePayload } from './TracePayload'
import { formatTime } from '@/lib/utils'
import { type TraceEntry } from '@/lib/trace-events'
import { getTraceDisplayEntries, type TraceDisplayEntry, type TraceMessageStream, type TraceReasoningStream, type TraceToolCall } from '@/lib/trace-calls'
import type { Run, Task } from '@/lib/types'
import './trace-panel.css'

const categoryIcons = {
  runtime: Play, session: Radio, turn: Activity, message: MessageSquare,
  reasoning: Brain, 'web-search': Globe, command: Terminal, 'file-change': FileDiff,
  tool: Wrench, result: MessageSquare, diagnostic: CircleAlert, output: Terminal, unknown: Activity,
} satisfies Record<TraceEntry['category'], typeof Activity>
const MemoTracePayload = memo(TracePayload)
const callLabels: Record<TraceToolCall['status'], string> = { running: '执行中', completed: '完成', failed: '失败', stopped: '已停止', incomplete: '未完成' }

function CopyValue({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState('')
  useEffect(() => setFeedback(''), [text])
  return <span className="trace-copy">
    {feedback && <span role="status">{feedback}</span>}
    <Button variant="ghost" size="icon-sm" title={label} aria-label={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setFeedback('已复制')).catch(() => setFeedback('复制失败'))
    }}>{feedback === '已复制' ? <Check size={12} /> : <Copy size={12} />}</Button>
  </span>
}
function CallDuration({ call }: { call: TraceToolCall }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (call.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [call.status])
  if (!call.startedAt || (!call.endedAt && call.status !== 'running')) return null
  const elapsed = ((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.startedAt)) / 1000
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  const label = elapsed < 60 ? `${elapsed < 10 ? elapsed.toFixed(1) : Math.floor(elapsed)} s` : `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`
  return <span className="trace-duration" aria-label={`耗时 ${label}`}>{label}</span>
}
function RawRecord({ event }: { event: TraceEntry }) {
  return <div className="trace-raw-record">
    <div className="trace-section-heading"><span className="trace-protocol" title={event.eventType ?? event.kind}>{event.eventType ?? event.kind}</span><CopyValue text={event.text} label="复制事件输出" /></div>
    <div className="trace-source-id" title={event.sourceIds.join('\n')}>{formatTime(event.timestamp)} · 记录 {event.sourceIds[0]?.slice(0, 12)}{event.sourceIds.length > 1 && ` · ${event.sourceIds.length} 个输出片段`}</div>
    <MemoTracePayload value={event.text || '无输出'} />
    {event.exitCode != null && <div className="trace-exit-code">退出码 {event.exitCode}</div>}
  </div>
}
function CallPayload({ direction, value, note, running = false }: { direction: 'input' | 'output'; value: unknown; note?: string; running?: boolean }) {
  const headingId = useId()
  const input = direction === 'input'
  const label = input ? '入参' : '出参'
  const Icon = input ? ArrowUpRight : ArrowDownLeft
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return <section className={`trace-call-payload trace-call-${direction}`} aria-labelledby={headingId} aria-busy={!input && running}>
    <div className="trace-section-heading"><h4 id={headingId}><Icon size={12} aria-hidden="true" />{label}<span aria-hidden="true">{input ? 'INPUT' : 'OUTPUT'}</span></h4>{value !== undefined && <CopyValue text={text ?? ''} label={`复制${label}`} />}</div>
    {value !== undefined && <MemoTracePayload value={value} />}
    {(note || value === undefined) && <p className="trace-payload-note">{!input && running && <Clock3 size={12} aria-hidden="true" />}{note ?? (input ? '此记录未提供入参。' : running ? '等待工具返回结果…' : '此记录未提供出参。')}</p>}
  </section>
}
function RawRecords({ records, callId, view, update }: { records: TraceEntry[]; callId?: string } & DetailState) {
  const pageSize = 50
  const page = Math.min(view.page, Math.max(0, Math.ceil(records.length / pageSize) - 1))
  const start = page * pageSize
  return <Collapsible className="trace-raw-records" open={view.rawOpen} onOpenChange={rawOpen => update({ rawOpen })}>
    <CollapsibleTrigger className="trace-raw-trigger"><CollapsibleIndicator size={12} /><span>原始记录</span><span>{records.length}</span></CollapsibleTrigger>
    <CollapsibleContent unmountOnExit>
      {callId && <div className="trace-call-id" title={callId}>调用 {callId}</div>}
      {records.length > pageSize && <div className="trace-record-pages" aria-label="原始记录分页">
        <span>{start + 1}–{Math.min(start + pageSize, records.length)} / {records.length}</span>
        <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => update({ page: page - 1 })}>上一页</Button>
        <Button variant="ghost" size="sm" disabled={start + pageSize >= records.length} onClick={() => update({ page: page + 1 })}>下一页</Button>
      </div>}
      {records.slice(start, start + pageSize).map(record => <RawRecord key={record.id} event={record} />)}
    </CollapsibleContent>
  </Collapsible>
}
function ToolCallDetail({ call, view, update }: { call: TraceToolCall } & DetailState) {
  return <div className="trace-detail trace-call-detail">
    <CallPayload direction="input" value={call.input} note={call.inputNote} />
    <CallPayload direction="output" value={call.output} note={call.outputNote} running={call.status === 'running'} />
    <RawRecords records={call.records} callId={call.id} view={view} update={update} />
  </div>
}

function StreamDetail({ stream, reasoning = false, view, update }: { stream: TraceMessageStream | TraceReasoningStream; reasoning?: boolean } & DetailState) {
  const headingId = useId()
  const label = reasoning ? '思考内容' : '回复内容'
  const tokens = reasoning ? (stream as TraceReasoningStream).estimatedTokens : undefined
  return <div className="trace-detail trace-call-detail">
    <section className="trace-call-payload" aria-labelledby={headingId} aria-busy={stream.status === 'running'}>
      <div className="trace-section-heading"><h4 id={headingId}>{label}<span>{stream.records.length} 个原始记录{tokens !== undefined && ` · ${tokens} tokens`}</span></h4><CopyValue text={stream.text} label={`复制完整${label}`} /></div>
      <pre className="trace-payload trace-payload-text" tabIndex={0} aria-label={label}><code>{stream.text}</code></pre>
    </section>
    <RawRecords records={stream.records} view={view} update={update} />
  </div>
}

interface RowView { open: boolean; rawOpen: boolean; page: number }
interface DetailState { view: RowView; update: (patch: Partial<RowView>) => void }
const eventKey = (event: TraceDisplayEntry) => event.id
const TraceRow = memo(function TraceRow({ event, member, views }: {
  event: TraceDisplayEntry
  member?: { name: string; role: string }
  views: Map<string, RowView>
}) {
  const [view, setView] = useState<RowView>(() => views.get(event.id) ?? { open: false, rawOpen: false, page: 0 })
  // Streaming and virtualization never open details without a user action.
  useEffect(() => { views.set(event.id, view) }, [event.id, views, view])
  const update = (patch: Partial<RowView>) => setView(previous => {
    const next = { ...previous, ...patch }
    views.set(event.id, next)
    return next
  })
  const Icon = categoryIcons[event.category]
  const call = event.call
  const stream = event.message ?? event.reasoning
  const label = call ? callLabels[call.status] : event.phase
  const running = call?.status === 'running' || stream?.status === 'running'
  return <Collapsible open={view.open} onOpenChange={open => update({ open })} className={`trace-event trace-severity-${event.severity}`} data-call-status={call?.status} data-message-status={event.message?.status} data-reasoning-status={event.reasoning?.status}>
    <CollapsibleTrigger className="trace-trigger" data-virtual-heading>
      <CollapsibleIndicator className="trace-chevron" size={13} />
      <Icon className="trace-type-icon" size={14} aria-hidden="true" />
      <div className="trace-event-heading">
        <div className="trace-event-title"><strong>{event.title}</strong>{label && <Badge variant="outline" className="trace-phase">{running && <LoaderCircle size={10} aria-hidden="true" className="trace-loading animate-spin motion-reduce:animate-none" />}{label}</Badge>}{call && <CallDuration call={call} />}</div>
        <small>{member?.name ?? event.memberId}{member?.role && ` · ${member.role}`} <span className="trace-time-range">· {formatTime(call?.startedAt ?? event.timestamp)}{call?.startedAt && call.endedAt && ` → ${formatTime(call.endedAt)}`}</span></small>
        {event.summary && <span className="trace-summary" title={event.summary}>{event.summary}</span>}
      </div>
    </CollapsibleTrigger>
    <CollapsibleContent unmountOnExit>{call ? <ToolCallDetail call={call} view={view} update={update} /> : event.message ? <StreamDetail stream={event.message} view={view} update={update} /> : event.reasoning ? <StreamDetail stream={event.reasoning} reasoning view={view} update={update} /> : <div className="trace-detail"><RawRecord event={event} /></div>}</CollapsibleContent>
  </Collapsible>
})

export function TracePanel({ task, run, onClose, onExport, initialMemberId, embedded = false }: { task: Task; run?: Run; initialMemberId?: string; embedded?: boolean; onClose: () => void; onExport: () => void }) {
  const [filter, setFilter] = useState(initialMemberId??'all')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const members = run?.members ?? task.members
  const selectedMember = members.some(member => member.id === filter) ? filter : 'all'
  const views = useMemo(() => new Map<string, RowView>(), [task.id, run?.id])
  const memberByRoute = useMemo(() => new Map(task.runs.flatMap(run => run.members.map(member => [JSON.stringify([run.id, member.id]), member] as const))), [task.runs])
  const entries = useMemo(() => getTraceDisplayEntries(task, run), [task, run])
  const events = entries.filter(event => (selectedMember === 'all' || event.memberId === selectedMember) && (!errorsOnly || event.severity === 'error'))
  const runningCount = events.filter(event => event.call?.status === 'running' || event.message?.status === 'running' || event.reasoning?.status === 'running').length
  return <aside className="trace-panel" aria-label="执行检查器">
    {!embedded && <div className="pane-heading"><span><Activity size={15} />执行过程</span><div className="flex gap-1"><Button variant="ghost" size="icon-sm" title="导出聊天与执行过程" aria-label="导出聊天与执行过程" onClick={onExport}><Download /></Button><Button variant="ghost" size="icon-sm" title="收起检查器" aria-label="收起检查器" onClick={onClose}><X /></Button></div></div>}
    <div className="trace-controls"><Select value={selectedMember} onValueChange={setFilter}><SelectTrigger aria-label="按成员筛选执行过程"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部成员</SelectItem>{members.map(m => <SelectItem key={m.id} value={m.id}><span className="inline-flex items-center gap-2"><RuntimeLogo runtime={run?.members.find(member => member.id === m.id)?.runtime} runtimeId={m.runtimeId} />{m.name} · {m.role}</span></SelectItem>)}</SelectContent></Select><Button variant={errorsOnly ? 'secondary' : 'ghost'} size="icon-sm" title="仅显示错误" aria-label="仅显示错误" aria-pressed={errorsOnly} onClick={() => setErrorsOnly(!errorsOnly)}><ListFilter /></Button></div>
    <div className="trace-meta"><span><Clock3 size={12} /> {events.length} 条记录</span><span>{runningCount ? `${runningCount} 项执行中` : '实时记录'}</span></div>
    <VirtualList key={`${task.id}:${run?.id ?? 'all'}:${selectedMember}:${errorsOnly}`} items={events} getKey={eventKey} label="执行记录（方向键切换，Home / End 跳到首尾）"
      empty={<div className="empty-trace"><Terminal size={24} /><p>{errorsOnly ? '没有错误事件' : '等待执行事件'}</p><span>{errorsOnly ? '当前筛选范围内没有已识别的错误。' : '启动 Agent 后，搜索、工具调用、回复与进程输出会出现在这里。'}</span></div>}
      renderItem={event => <TraceRow event={event} member={memberByRoute.get(JSON.stringify([event.runId, event.memberId])) ?? members.find(member => member.id === event.memberId)} views={views} />}
    />
    <div className="trace-bottom"><Status status={run?.members.some(m => m.status === 'running') ? 'running' : 'idle'} label={task.demo ? '示例事件' : '本地进程记录'} /><p>连续回复、思考流与同一工具调用合并展示，原始记录完整保留。</p></div>
  </aside>
}
