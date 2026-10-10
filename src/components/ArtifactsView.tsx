import { useState } from 'react'
import { Check, Copy, FileText, ArrowUpRight } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import type { Task } from '@/lib/types'
import type { Artifact } from '@/lib/artifacts'
import './artifacts.css'
import { useI18n } from '@/i18n'

function ArtifactRow({ task, artifact, onOpen }: { task: Task; artifact: Artifact; onOpen?: (artifact: Artifact) => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const location = artifact.url ?? (artifact.path ? artifact.path.startsWith('/') ? artifact.path : `${artifact.directory.replace(/\/$/, '')}/${artifact.path}` : undefined)
  const copyLabel = artifact.url ? t('复制链接', 'Copy link') : artifact.path ? t('复制路径', 'Copy path') : t('复制内容', 'Copy content')
  const runIndex = task.runs.findIndex(run => run.id === artifact.runId)
  const member = task.runs[runIndex]?.members.find(member => member.id === artifact.memberId)?.name ?? 'Agent'
  const source = artifact.source === 'inline' ? t('回复中的文件内容', 'File content in reply') : artifact.source === 'saved' ? t('已另存为文件', 'Saved as file') : artifact.source === 'tool' ? t('工具文件变更', 'File changed by tool') : t('回复引用', 'Referenced in reply')
  return <>
    <div className="artifact-row">
      <FileIcon name={artifact.name} kind={artifact.kind}/>
      <Tooltip><TooltipTrigger asChild><Button variant="link" className="artifact-name" onClick={() => onOpen?.(artifact)}>{artifact.name}</Button></TooltipTrigger>
        <TooltipContent className="artifact-details-tooltip"><div>{artifact.name}</div>{location && <div>{location}</div>}<div>{member}{runIndex >= 0 ? t(` · 第 ${runIndex + 1} 次执行`, ` · Run ${runIndex + 1}`) : ''} · {source}</div></TooltipContent>
      </Tooltip>
      <span className="artifact-path" title={location}>{location ?? t('回复内容', 'Reply content')}</span>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`${copyLabel} ${artifact.name}`} disabled={!location && artifact.content === undefined} onBlur={() => setCopied(false)} onClick={async () => {
        setCopied(false); setError('')
        try { await navigator.clipboard.writeText(location ?? artifact.content!); setCopied(true) }
        catch { setError(t('复制失败，请重试。', 'Copy failed. Try again.')) }
      }}>{copied ? <Check/> : <Copy/>}</Button></TooltipTrigger><TooltipContent>{copied ? t('已复制', 'Copied') : copyLabel}</TooltipContent></Tooltip>
      <Button variant="ghost" size="icon-sm" aria-label={`${t('预览', 'Preview')} ${artifact.name}`} title={t('预览', 'Preview')} onClick={() => onOpen?.(artifact)}><ArrowUpRight/></Button>
      <span className="sr-only" role="status">{copied ? t(`${copyLabel}成功`, `${copyLabel} successful`) : ''}</span>
    </div>
    {error && <p className="artifact-error" role="alert">{error}</p>}
  </>
}

export function ArtifactsView({ task, artifacts, onOpen, onSubmit }: { task: Task; artifacts: Artifact[]; onOpen?: (artifact: Artifact) => void; onSubmit: () => void }) {
  const { t } = useI18n()
  return <TooltipProvider><div className="artifacts-view" aria-label={t('任务产物', 'Task artifacts')}>
    {artifacts.map(artifact => <ArtifactRow key={artifact.id} task={task} artifact={artifact} onOpen={onOpen}/>)}
    {task.demo && ['CommandPalette.tsx', 'useCommandSearch.ts', 'command-palette.spec.ts'].map(name => <div className="artifact-row" key={name}><FileIcon name={name}/><span className="artifact-summary">{name}</span><Badge variant="outline" title={t('示例文件，不对应本机文件', 'Example file; not present on this computer')}>{t('示例', 'Example')}</Badge></div>)}
    {task.results?.map(result => <div className="artifact-row" key={result.id}><FileText size={16}/><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="artifact-summary">{result.summary}</span></TooltipTrigger><TooltipContent className="artifact-details-tooltip">{result.summary}<br/>{result.evidence || t('未附加来源', 'No source attached')}</TooltipContent></Tooltip><Badge variant="outline">{result.verdict === 'accepted' ? t('已验收', 'Accepted') : t('待确认', 'Pending review')}</Badge></div>)}
    {!task.demo && !artifacts.length && !task.results?.length && <div className="empty-artifacts"><FileText size={26}/><h3>{t('暂无任务产物', 'No task artifacts yet')}</h3><p>{t('生成的文件、回复引用的路径和 HTML / Markdown 文档会自动汇总到这里。', 'Generated files, paths referenced in replies, and HTML / Markdown documents appear here automatically.')}</p><Button variant="outline" onClick={onSubmit}>{t('手动提交结果', 'Submit result manually')}</Button></div>}
  </div></TooltipProvider>
}
