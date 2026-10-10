import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown, ArrowRight, ArrowUp, Brain, Check, ChevronDown, Folder, GitBranch, History, Layers, LoaderCircle, Plus, Settings2, Square, Terminal, Trash2, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Status } from './Status'
import { ArtifactsView } from './ArtifactsView'
import { FileIcon } from './FileIcon'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { artifactFromLink, getTaskArtifacts, type Artifact } from '@/lib/artifacts'
import { MarkdownMessage } from './MarkdownMessage'
import { UserMessage } from './UserMessage'
import { RuntimeLogo } from './RuntimeLogo'
import { RuntimeApprovalPanel } from './RuntimeApprovalPanel'
import { ComposerRecipient } from './ComposerRecipient'
import { ComposerAttachments } from './ComposerAttachments'
import { useComposerAttachments } from './useComposerAttachments'
import { promptWithAttachments } from '@/lib/attachments'
import { MemberConfiguration } from './MemberConfiguration'
import { RunActivityList, RunFeedback } from './RunFeedback'
import { hoverFeedbackHandlers, quietSpring } from '@/lib/motion'
import { getTaskStatus } from '@/lib/domain'
import { groupConversationMessages } from '@/lib/conversation'
import { formatTime } from '@/lib/utils'
import type { Member, Message, Settings, Task } from '@/lib/types'

interface Props {
  task: Task; settings: Settings; selectedRunId: string; onSelectRun: (id: string) => void
  onChange: (task: Task) => void; onSend: (prompt: string, recipient: string) => Promise<void>
  onStop: () => void; onSettings: () => void; onInspector: () => void; onToggleInspector?: () => void; inspectorOpen: boolean
  onDuplicate: () => void
  artifacts?: Artifact[]; onOpenArtifact?: (artifact: Artifact) => void
  taskActions?: ReactNode
  operations?: ReactNode; agentActions?:(memberId:string)=>ReactNode; goalTitle?:string; onGoal?:()=>void
}
function ReasoningPart({ part }: { part: Message }) {
  return <Collapsible defaultOpen={Boolean(part.streaming)} className="reasoning-part" data-streaming={part.streaming || undefined}>
    <CollapsibleTrigger className="reasoning-trigger">
      <CollapsibleIndicator size={13} />
      <Brain size={13} aria-hidden="true" />
      <span>思考过程</span>
      {part.streaming && <span className="reasoning-status">正在思考…</span>}
    </CollapsibleTrigger>
    <CollapsibleContent><pre className="reasoning-content" tabIndex={0} aria-label="思考过程">{part.text}</pre></CollapsibleContent>
  </Collapsible>
}
export function Workbench({ task, settings, selectedRunId, onSelectRun, onChange, onSend, onStop, onSettings, onInspector, onToggleInspector, inspectorOpen, onDuplicate, artifacts: suppliedArtifacts, onOpenArtifact, taskActions, operations, agentActions, goalTitle, onGoal }: Props) {
  const artifacts = useMemo(() => suppliedArtifacts ?? getTaskArtifacts(task), [suppliedArtifacts, task.messages, task.events, task.runs, task.directory, task.id, task.artifacts])
  const [tab, setTab] = useState('conversation')
  const [memberId, setMemberId] = useState(task.members[0]?.id ?? '')
  const [configMemberId, setConfigMemberId] = useState(task.members[0]?.id ?? '')
  const [showJump, setShowJump] = useState(false)
  const [recipient, setRecipient] = useState(task.members[0]?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [handoff, setHandoff] = useState<{ member: Member; runtimeId: string } | null>(null)
  const [managing, setManaging] = useState(false)
  const recipientTrigger = useRef<HTMLButtonElement>(null)
  const instruction = useRef<HTMLTextAreaElement>(null)
  const clipboard = useComposerAttachments(instruction, (text, start, end) => {
    setPrompt(current => current.slice(0, start) + text + current.slice(end))
    requestAnimationFrame(() => instruction.current?.setSelectionRange(start + text.length, start + text.length))
  }, setError)
  const sendPending = useRef(false)
  const [adding, setAdding] = useState(false)
  const [newRole, setNewRole] = useState('协作成员')
  const [newRuntime, setNewRuntime] = useState(settings.defaultRuntime)
  const follow = useRef(true)
  const chat = useRef<HTMLDivElement>(null)
  const chatContent = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const running = task.runs.some(r => r.members.some(m => m.status === 'running'))
  const latest = task.runs.at(-1)
  const selectedRun = task.runs.find(r => r.id === selectedRunId) ?? latest
  const historic = !!selectedRun && selectedRun !== latest
  const visibleArtifacts = historic ? artifacts.filter(item => item.runId === selectedRun?.id) : artifacts
  const displayedMembers = running || historic ? selectedRun?.members ?? task.members : task.members
  const visibleMembers = task.mode === 'solo' && !running && !historic ? displayedMembers.slice(0, 1) : displayedMembers
  const messages = useMemo(() => groupConversationMessages(task.messages).filter(m => (!historic || m.runId === selectedRun?.id) && (tab !== 'member' || m.memberId === memberId || m.role === 'user')), [task.messages, historic, selectedRun?.id, tab, memberId])

  function scrollToLatest() {
    follow.current = true
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight
    setShowJump(false)
  }
  useLayoutEffect(() => {
    if (follow.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight
  }, [messages, task.events, selectedRun, tab])
  useLayoutEffect(() => { scrollToLatest() }, [task.id, selectedRun?.id, tab, memberId])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !chatContent.current) return
    const observer = new ResizeObserver(() => {
      if (follow.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight
    })
    observer.observe(chatContent.current)
    return () => observer.disconnect()
  }, [tab, task.id])
  useEffect(() => {
    if (!task.members.some(m => m.id === recipient) && recipient !== 'all') setRecipient(task.members[0]?.id ?? '')
    const members = historic ? selectedRun?.members ?? [] : task.members
    if (!members.some(m => m.id === memberId)) setMemberId(members[0]?.id ?? '')
    if (!members.some(m => m.id === configMemberId)) setConfigMemberId(members[0]?.id ?? '')
  }, [task.members, recipient, memberId, configMemberId, historic, selectedRun])

  useLayoutEffect(() => {
    const node = instruction.current
    if (!node) return
    const resize = () => { node.style.height = '0px'; node.style.height = `${Math.min(160, Math.max(40, node.scrollHeight))}px` }
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; resize() }
    })
    let width = node.clientWidth
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [prompt, historic, task.demo, tab])

  function patchMember(id: string, patch: Partial<Member>) { onChange({ ...task, members: task.members.map(m => m.id === id ? { ...m, ...patch } : m) }) }
  function changeMode(mode: 'solo' | 'team') {
    if (running || historic) return
    let members = task.members
    if (mode === 'team' && members.length === 1) {
      const runtime = settings.runtimes.find(r => r.enabled && r.id !== members[0].runtimeId) ?? settings.runtimes.find(r => r.enabled)
      if (runtime && settings.maxParallel > 1) members = [...members, { id: crypto.randomUUID(), name: runtime.name, role: '测试 / 审查', runtimeId: runtime.id, modelId: runtime.defaultModel }]
    }
    if (mode === 'solo') setRecipient(members[0]?.id ?? '')
    onChange({ ...task, mode, members })
  }
  async function send() {
    if ((!prompt.trim() && !clipboard.attachments.length) || clipboard.pending.current || sendPending.current || running || historic || task.demo) return
    sendPending.current = true
    const submitted = prompt
    const submittedAttachments = clipboard.attachments
    setSending(true); setError('')
    try { await onSend(promptWithAttachments(submitted, submittedAttachments), task.mode === 'solo' ? task.members[0]?.id ?? '' : recipient); setPrompt(current => current === submitted ? '' : current); clipboard.submitted(submittedAttachments.map(file => file.id)); follow.current = true }
    catch (e) { setError(String(e).replace('Error: ', '')) }
    finally { sendPending.current = false; setSending(false) }
  }
  const selectableRuntimes = historic ? [...new Map((selectedRun?.members ?? []).map(m => [m.runtime.id, m.runtime])).values()] : settings.runtimes.filter(r => r.enabled)
  const configuration = <MemberConfiguration task={task} settings={settings} selectedRun={selectedRun} historic={historic} running={running} memberId={configMemberId} onSelectMember={setConfigMemberId} onPatchMember={patchMember} onHandoff={(member, runtimeId) => setHandoff({ member, runtimeId })} onSettings={onSettings} onRemove={id => onChange({ ...task, members: task.members.filter(member => member.id !== id) })} onAdd={() => { setNewRuntime(selectableRuntimes[0]?.id ?? ''); setAdding(true) }} />
  return <main className="workbench">
    <header className="task-heading">
      <div className="task-title-row">
        <TooltipProvider><Tooltip><TooltipTrigger asChild><h1 data-task-heading tabIndex={0}>{task.title}</h1></TooltipTrigger><TooltipContent>{task.title}</TooltipContent></Tooltip></TooltipProvider>
        <Status status={getTaskStatus(historic && selectedRun ? { ...task, runs: [selectedRun] } : task)} />
        {task.demo && <Badge variant="outline">示例任务</Badge>}
        <div className="task-heading-actions">{taskActions}<Button variant="ghost" size="icon-sm" title="打开执行检查器" aria-label="打开执行检查器" data-inspector-toggle aria-controls="execution-inspector" aria-expanded={inspectorOpen} onClick={onToggleInspector ?? onInspector} aria-pressed={inspectorOpen}><Layers /></Button></div>
      </div>
      <div className="task-toolbar">
        <div className="task-context">
          {goalTitle && <TooltipProvider><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="task-goal-link" onClick={onGoal} aria-label={`所属目标：${goalTitle}`}><GitBranch size={14} /></Button></TooltipTrigger><TooltipContent>所属目标：{goalTitle}</TooltipContent></Tooltip></TooltipProvider>}
          <TooltipProvider><Tooltip><TooltipTrigger asChild><span className="task-directory" tabIndex={0}><Folder size={12} /><span>{task.directory || '新任务需要选择工作目录'}</span></span></TooltipTrigger><TooltipContent>{task.directory || '新任务需要选择工作目录'}</TooltipContent></Tooltip></TooltipProvider>
        </div>
      <div className="task-actions"><div className="mode-switch" aria-label="执行模式" {...hoverFeedbackHandlers<HTMLDivElement>({})}>{(['solo', 'team'] as const).map(mode => <Button key={mode} variant="ghost" size="sm" disabled={running || historic} aria-pressed={task.mode === mode} onClick={() => changeMode(mode)}>{task.mode === mode && <motion.span className="mode-indicator" layoutId={`mode-${task.id}`} transition={reduced ? { duration: 0 } : quietSpring} />}<span className="relative flex items-center gap-1.5">{mode === 'solo' ? <Terminal size={13} /> : <Users size={13} />}{mode === 'solo' ? '单 Agent' : '协作'}</span></Button>)}</div>
        <div className="flex items-center gap-2 ml-auto">{task.runs.length > 0 && <Select value={selectedRun?.id} onValueChange={onSelectRun}><SelectTrigger className="run-select" aria-label="执行历史"><History size={12} /><SelectValue>第 {task.runs.findIndex(run => run.id === selectedRun?.id) + 1} 次执行</SelectValue></SelectTrigger><SelectContent>{task.runs.map((r, i) => <SelectItem key={r.id} value={r.id}>第 {i + 1} 次执行 {r === latest ? '· 最新' : ''}</SelectItem>)}</SelectContent></Select>}{running && <Button variant="outline" size="sm" onClick={onStop}><Square size={11} />停止执行</Button>}</div>
      </div>
      </div>
      {(running||task.orchestration==='running')&&taskActions&&<p className="task-action-lock-note">请先停止执行和编排，再编辑或删除</p>}
    </header>
    <Tabs value={tab} onValueChange={setTab} className="work-tabs">
      <div className="work-tab-bar"><TabsList><TabsTrigger value="conversation">任务对话</TabsTrigger><TabsTrigger value="member">成员会话</TabsTrigger><TabsTrigger value="operations" disabled={!operations}>任务与编排</TabsTrigger><TabsTrigger value="artifacts">产物 <span className="tab-count">{task.demo ? 3 : visibleArtifacts.length + (task.results?.length ?? 0)}</span></TabsTrigger></TabsList><span>{task.mode === 'team' ? `${visibleMembers.length} 个成员` : '独立执行'} · 本地记录</span></div>
      {tab === 'member' && <div className="member-session-tabs">{visibleMembers.map(m => <Button key={m.id} size="sm" variant={m.id === memberId ? 'secondary' : 'ghost'} onClick={() => setMemberId(m.id)}><RuntimeLogo runtime={running || historic ? selectedRun?.members.find(snapshot => snapshot.id === m.id)?.runtime : settings.runtimes.find(runtime => runtime.id === m.runtimeId)} size={14} />{m.name} · {m.role}</Button>)}</div>}
      {tab === 'operations' ? <div className="task-operations-scroll">{historic&&selectedRun?<div className="historical-context"><h2>本次执行的上下文快照</h2><p>执行于 {new Date(selectedRun.createdAt).toLocaleString('zh-CN')}，后续修改不会改变这里的记录。</p><h3>任务要求</h3><p>{selectedRun.context?.task.title??task.title}</p><p>{selectedRun.context?.task.acceptance||'该执行未记录验收要求'}</p>{selectedRun.context?.goal&&<><h3>{selectedRun.context.goal.title} · 目标 v{selectedRun.context.goal.version}</h3><p>{selectedRun.context.goal.expected}</p><h3>当时的现状 · v{selectedRun.context.goal.currentState.version}</h3><p>{selectedRun.context.goal.currentState.summary}</p>{selectedRun.context.goal.currentState.entries.map(entry=><p key={entry.id}>{entry.text} · {entry.source.label}</p>)}</>}<h3>职责快照</h3>{selectedRun.members.map(member=><p key={member.id}><strong>{member.name}</strong> · {member.role}<br/>{member.instructions||'未记录额外职责指令'}</p>)}</div>:operations}</div> : tab === 'artifacts' ? <ArtifactsView task={task} artifacts={visibleArtifacts} onOpen={onOpenArtifact} onSubmit={() => setTab('operations')} /> : <div className="chat-region"><div className="chat-scroll" aria-label="任务对话记录" ref={chat} onScroll={() => {
        if (!chat.current) return
        const atBottom = chat.current.scrollHeight - chat.current.scrollTop - chat.current.clientHeight < 64
        follow.current = atBottom
        setShowJump(!atBottom)
      }}><div ref={chatContent}>
        {messages.length === 0 ? <div className="conversation-empty"><div className="empty-terminal"><Terminal size={24} /></div><h2>准备好，开始一项任务</h2><p>给 Agent 一个明确目标。执行过程与结果会保存在这个任务中。</p><div className="starter-prompts">{['分析项目结构并给出改进建议', '检查最近的代码变更', '为核心模块补充测试'].map(text => <Button variant="outline" key={text} onClick={() => setPrompt(text)}>{text}<ArrowRight size={13} /></Button>)}</div></div> : messages.map(message => {
          const snapshot = task.runs.find(run => run.id === message.runId)?.members.find(member => member.id === message.memberId)
          const member = snapshot ?? task.members.find(member => member.id === message.memberId)
          const messageArtifacts = message.role === 'assistant' ? artifacts.filter(item => message.parts.some(part => part.id === item.sourceId || item.sourceId.startsWith(`${part.id}:block:`))) : []
          const reasoningStreaming = message.parts.some(part => part.kind === 'reasoning' && part.streaming)
          const replyStreaming = message.parts.some(part => part.kind !== 'reasoning' && part.streaming)
          return <article key={message.id} className={`chat-message message-${message.role}`}>
            <div className={`message-avatar ${message.role === 'user' ? 'avatar-user' : ''}`}>
              {message.role === 'user' ? <span>你</span> : message.role === 'assistant' ? <RuntimeLogo runtime={snapshot?.runtime} size={18} /> : <Terminal size={14} />}
            </div>
            <div className="message-body">
              <div className="message-heading"><strong>{message.role === 'user' ? '你' : message.role === 'system' ? '执行记录' : member?.name ?? 'Agent'}</strong>{message.role === 'assistant' && <span className="member-label">{member?.role}</span>}<time>{formatTime(message.createdAt)}</time></div>
              <div className="message-text">{message.role === 'assistant' ? message.parts.map(part => <div className={`message-part message-part-${part.kind ?? 'message'}`} key={part.id}>{part.kind === 'reasoning' ? <ReasoningPart part={part} /> : <MarkdownMessage text={part.text} onOpenLink={onOpenArtifact ? href => {
                const artifact = artifactFromLink(href, { directory: task.runs.find(run => run.id === part.runId)?.directory ?? task.directory, runId: part.runId, memberId: part.memberId, sourceId: part.id, createdAt: part.createdAt }, task.id)
                if (artifact) onOpenArtifact(artifacts.find(item => item.id === artifact.id) ?? artifact)
              } : undefined} />}</div>) : message.role === 'user' ? <UserMessage text={message.text} /> : message.text}</div>
              {messageArtifacts.length > 0 && <TooltipProvider><div className="message-artifacts" role="group" aria-label="回复产物">
                {messageArtifacts.map(item => <Tooltip key={item.id}>
                  <TooltipTrigger asChild><Button variant="outline" size="sm" className="message-artifact" aria-label={`预览 ${item.name}`} onClick={() => onOpenArtifact?.(item)}>
                    <FileIcon name={item.name} kind={item.kind}/><span className="message-artifact-name">{item.name}</span><ArrowRight className="message-artifact-arrow" aria-hidden="true"/>
                  </Button></TooltipTrigger>
                  <TooltipContent className="artifact-details-tooltip" side="top" sideOffset={8}><div>{item.name}</div><div>{item.url ?? (item.path ? item.path.startsWith('/') ? item.path : `${item.directory.replace(/\/$/, '')}/${item.path}` : '回复内容')}</div></TooltipContent>
                </Tooltip>)}
              </div></TooltipProvider>}
              {message.role === 'assistant' && <div className="message-foot">{snapshot?.status === 'running' ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" /> : <Check size={12} />}{task.demo ? '示例内容' : snapshot?.status === 'running' ? replyStreaming ? '正在输出…' : reasoningStreaming ? '正在思考…' : '正在执行…' : 'Runtime 输出'}<Button variant="ghost" size="sm" onClick={onInspector}>查看执行 <ArrowRight size={11} /></Button></div>}
            </div>
          </article>
        })}
        {selectedRun && !task.demo && <RunActivityList task={task} run={selectedRun} memberId={tab === 'member' ? memberId : undefined} onInspector={onInspector} />}
      </div></div>{showJump && <Button variant="secondary" size="sm" className="chat-jump" onClick={scrollToLatest}><ArrowDown size={13} />回到最新</Button>}</div>}
    </Tabs>
    <RuntimeApprovalPanel task={task}/>{tab!=='operations'&&tab!=='artifacts'&&<div className="composer-wrap">
      {selectedRun && !task.demo && <RunFeedback task={task} run={selectedRun} onStop={!historic && running ? onStop : undefined} onInspector={onInspector} />}
      {error && <div className="inline-error" role="alert">{error}<Button size="icon-sm" variant="ghost" aria-label="关闭发送错误" onClick={() => setError('')}><X /></Button></div>}
      {task.demo ? <div className="demo-notice"><span>这是示例任务，创建真实任务后开始执行。</span><Button size="sm" variant="outline" onClick={onDuplicate}>创建真实任务 <ArrowRight size={12} /></Button></div> : historic ? <div className="demo-notice"><span>历史执行 · 成员配置与输出保持当时快照</span><Button size="sm" variant="outline" onClick={() => onSelectRun(latest?.id ?? '')}>返回最新执行</Button></div> : null}
      <div className="composer">
        <div className="composer-recipient" ref={node => { recipientTrigger.current = node?.querySelector('button') ?? null }}><ComposerRecipient task={task} settings={settings} selectedRun={selectedRun} historic={historic} running={running} recipient={recipient} onRecipient={setRecipient} onPatch={patchMember} onManage={() => setManaging(true)} onSettings={onSettings} /></div>
        <ComposerAttachments attachments={clipboard.attachments} importing={clipboard.importing} onRemove={clipboard.remove} />
        <Textarea ref={instruction} onPaste={clipboard.onPaste} aria-label="任务指令" aria-describedby="composer-keyboard-hint" disabled={task.demo || historic} placeholder={task.demo ? '创建真实任务后开始执行…' : historic ? '历史执行只读' : running ? '可以先写下下一条指令，当前执行结束后发送…' : '描述任务，或粘贴图片和文件…'} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void send() } }} />
        <div className="composer-send-row"><span id="composer-keyboard-hint" className="sr-only">⌘ Enter 或 Ctrl Enter 发送，Enter 换行</span><Button className="composer-send" size="icon" onClick={() => void send()} disabled={task.demo || historic || sending || running || clipboard.importing || (!prompt.trim() && !clipboard.attachments.length)} aria-label={sending ? '正在发送指令' : '发送指令'} title={running ? '当前执行结束后可发送' : '发送指令（⌘ Enter / Ctrl Enter）'}>{sending ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <ArrowUp size={16} />}</Button></div>
      </div>
    </div>
    }<Dialog open={managing} onOpenChange={setManaging}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); recipientTrigger.current?.focus() }}><DialogHeader><DialogTitle>成员与 Runtime</DialogTitle><DialogDescription>管理成员与下一次执行配置。查看或配置成员不会改变发送目标。</DialogDescription></DialogHeader>{configuration}{!historic && !task.demo && agentActions?.(configMemberId)}</DialogContent></Dialog>
    <Dialog open={!!handoff} onOpenChange={open => { if (!open) setHandoff(null) }}><DialogContent><DialogHeader><DialogTitle>切换 Runtime</DialogTitle><DialogDescription>下一次执行会创建独立会话，并交接任务目标和已保存的完整公开对话。历史执行保持原配置。</DialogDescription></DialogHeader><div className="handoff-preview"><p>任务：{task.title}</p><p>成员职责：{handoff?.member.role}</p><p>Runtime：{settings.runtimes.find(r => r.id === handoff?.member.runtimeId)?.name} → {settings.runtimes.find(r => r.id === handoff?.runtimeId)?.name}</p><p>{running ? '当前执行继续，新配置在下次执行生效。' : '新会话使用新 Runtime 的默认模型。'}</p></div><DialogFooter><Button variant="outline" onClick={() => setHandoff(null)}>取消</Button><Button onClick={() => { if (handoff) { const r = settings.runtimes.find(r => r.id === handoff.runtimeId); patchMember(handoff.member.id, { runtimeId: handoff.runtimeId, name: r?.name ?? handoff.runtimeId, modelId: r?.defaultModel ?? '', reasoningEffort: undefined }); setHandoff(null) } }}>确认交接配置</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={adding} onOpenChange={setAdding}><DialogContent><DialogHeader><DialogTitle>添加 Agent 成员</DialogTitle><DialogDescription>为同一个任务配置独立的执行成员。全局默认值会复制为成员配置。</DialogDescription></DialogHeader><Label htmlFor="member-role">职责</Label><Input id="member-role" value={newRole} onChange={e => setNewRole(e.target.value)} /><Label>Runtime</Label><Select value={newRuntime} onValueChange={setNewRuntime}><SelectTrigger aria-label="新成员 Runtime"><SelectValue /></SelectTrigger><SelectContent>{selectableRuntimes.map(r => <SelectItem key={r.id} value={r.id} textValue={r.name}><span className="inline-flex items-center gap-2"><RuntimeLogo runtime={r} size={16} /><span>{r.name}</span></span></SelectItem>)}</SelectContent></Select><Button variant="ghost" className="justify-start" onClick={() => { setAdding(false); onSettings() }}><Settings2 />管理 Runtime 与模型</Button><DialogFooter><Button onClick={() => { const r = settings.runtimes.find(r => r.id === newRuntime); if (r) { onChange({ ...task, members: [...task.members, { id: crypto.randomUUID(), name: r.name, role: newRole.trim() || '协作成员', runtimeId: r.id, modelId: r.defaultModel }] }); setAdding(false) } }} disabled={!newRole.trim() || !newRuntime}>添加成员</Button></DialogFooter></DialogContent></Dialog>
  </main>
}
