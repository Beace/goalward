import { useState } from 'react'
import { Check, Copy, FileText, ArrowUpRight } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import type { Task } from '@/lib/types'
import type { Artifact } from '@/lib/artifacts'
import './artifacts.css'

function ArtifactRow({ task, artifact, onOpen }: { task: Task; artifact: Artifact; onOpen?: (artifact: Artifact) => void }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const location = artifact.url ?? (artifact.path ? artifact.path.startsWith('/') ? artifact.path : `${artifact.directory.replace(/\/$/, '')}/${artifact.path}` : undefined)
  const copyLabel = artifact.url ? '复制链接' : artifact.path ? '复制路径' : '复制内容'
  const runIndex = task.runs.findIndex(run => run.id === artifact.runId)
  const member = task.runs[runIndex]?.members.find(member => member.id === artifact.memberId)?.name ?? 'Agent'
  const source = artifact.source === 'inline' ? '回复中的文件内容' : artifact.source === 'saved' ? '已另存为文件' : artifact.source === 'tool' ? '工具文件变更' : '回复引用'
  return <>
    <div className="artifact-row">
      <FileIcon name={artifact.name} kind={artifact.kind}/>
      <Tooltip><TooltipTrigger asChild><Button variant="link" className="artifact-name" onClick={() => onOpen?.(artifact)}>{artifact.name}</Button></TooltipTrigger>
        <TooltipContent className="artifact-details-tooltip"><div>{artifact.name}</div>{location && <div>{location}</div>}<div>{member}{runIndex >= 0 ? ` · 第 ${runIndex + 1} 次执行` : ''} · {source}</div></TooltipContent>
      </Tooltip>
      <span className="artifact-path" title={location}>{location ?? '回复内容'}</span>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`${copyLabel} ${artifact.name}`} disabled={!location && artifact.content === undefined} onBlur={() => setCopied(false)} onClick={async () => {
        setCopied(false); setError('')
        try { await navigator.clipboard.writeText(location ?? artifact.content!); setCopied(true) }
        catch { setError('复制失败，请重试。') }
      }}>{copied ? <Check/> : <Copy/>}</Button></TooltipTrigger><TooltipContent>{copied ? '已复制' : copyLabel}</TooltipContent></Tooltip>
      <Button variant="ghost" size="icon-sm" aria-label={`预览 ${artifact.name}`} title="预览" onClick={() => onOpen?.(artifact)}><ArrowUpRight/></Button>
      <span className="sr-only" role="status">{copied ? `${copyLabel}成功` : ''}</span>
    </div>
    {error && <p className="artifact-error" role="alert">{error}</p>}
  </>
}

export function ArtifactsView({ task, artifacts, onOpen, onSubmit }: { task: Task; artifacts: Artifact[]; onOpen?: (artifact: Artifact) => void; onSubmit: () => void }) {
  return <TooltipProvider><div className="artifacts-view" aria-label="任务产物">
    {artifacts.map(artifact => <ArtifactRow key={artifact.id} task={task} artifact={artifact} onOpen={onOpen}/>)}
    {task.demo && ['CommandPalette.tsx', 'useCommandSearch.ts', 'command-palette.spec.ts'].map(name => <div className="artifact-row" key={name}><FileIcon name={name}/><span className="artifact-summary">{name}</span><Badge variant="outline" title="示例文件，不对应本机文件">示例</Badge></div>)}
    {task.results?.map(result => <div className="artifact-row" key={result.id}><FileText size={16}/><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="artifact-summary">{result.summary}</span></TooltipTrigger><TooltipContent className="artifact-details-tooltip">{result.summary}<br/>{result.evidence || '未附加来源'}</TooltipContent></Tooltip><Badge variant="outline">{result.verdict === 'accepted' ? '已验收' : '待确认'}</Badge></div>)}
    {!task.demo && !artifacts.length && !task.results?.length && <div className="empty-artifacts"><FileText size={26}/><h3>暂无任务产物</h3><p>生成的文件、回复引用的路径和 HTML / Markdown 文档会自动汇总到这里。</p><Button variant="outline" onClick={onSubmit}>手动提交结果</Button></div>}
  </div></TooltipProvider>
}
