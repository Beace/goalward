import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Code2, Copy, ExternalLink, Eye, FolderOpen, RefreshCw, Save } from 'lucide-react'
import { Button } from './ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { MarkdownMessage } from './MarkdownMessage'
import { FileIcon } from './FileIcon'
import { htmlPreviewDocument, type Artifact } from '@/lib/artifacts'
import { isDesktop, openArtifact, readArtifact, saveArtifact, normalizeExternalHttpUrl, openExternalUrl } from '@/lib/bridge'
import './artifacts.css'

export function ArtifactPreview({ artifact, onSaved, onOpenLink }: { artifact: Artifact; onOpenLink?: (href: string) => void; onSaved?: (artifact: Artifact, path: string) => Promise<void> }) {
  const remoteUrl = artifact.url && normalizeExternalHttpUrl(artifact.url)
  const imageFile = !artifact.url && /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic|heif)$/i.test(artifact.path ?? artifact.name)
  const [content, setContent] = useState<string>()
  const [imageDataUrl, setImageDataUrl] = useState<string>()
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [mode, setMode] = useState('preview')
  const [revision, setRevision] = useState(0)
  const source = useRef('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [artifact.id])
  useEffect(() => {
    let active = true
    const identity = JSON.stringify([artifact.id, artifact.path, artifact.directory, remoteUrl])
    const changed = source.current !== identity
    source.current = identity
    if (changed) { setContent(undefined); setImageDataUrl(undefined); setMode('preview') }
    setError(''); setActionError(''); setNotice('')
    if (artifact.url) { setReading(false); if (!remoteUrl) setError('此网页链接无效。') }
    else if (artifact.content !== undefined) { setContent(artifact.content); setReading(false) }
    else if (artifact.path) {
      setReading(true)
      void readArtifact(artifact.directory, artifact.path).then(file => {
        if (!active) return
        setContent(file.imageDataUrl ? undefined : file.content); setImageDataUrl(file.imageDataUrl); setRevision(n => n + 1)
        if (!changed) setNotice(`已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
      }).catch(error => { if (active) setError(String(error).replace(/^Error: /, '')) })
        .finally(() => { if (active) setReading(false) })
    }
    return () => { active = false }
  }, [artifact.id, artifact.content, artifact.path, artifact.directory, artifact.url, remoteUrl, refresh])
  const html = useMemo(() => artifact.kind === 'html' && content !== undefined ? htmlPreviewDocument(content) : '', [artifact.kind, content])
  async function action(work: () => Promise<unknown>, success = '') {
    setBusy(true); setActionError(''); setNotice('')
    try { const result = await work(); if (result !== null) setNotice(success) } catch (error) { setActionError(String(error).replace(/^Error: /, '')) } finally { setBusy(false) }
  }
  const location = artifact.url ?? (artifact.path ? artifact.path.startsWith('/') ? artifact.path : `${artifact.directory}/${artifact.path}` : '回复中的文件内容')
  return <aside className="artifact-preview" aria-label="产物预览">
    <Tabs value={mode} onValueChange={setMode} className="artifact-preview-tabs">
      <div className="artifact-toolbar" aria-label="产物操作">
        <FileIcon name={artifact.name} kind={artifact.kind}/>
        <h2 ref={heading} tabIndex={-1} title={`${artifact.name}\n${location}`}>{artifact.name}</h2>
        <span className="artifact-toolbar-status" role="status" title={reading ? '正在重新读取文件…' : notice}>
          {notice && !reading && <Check size={12} aria-hidden="true"/>}<span className="sr-only">{reading ? '正在重新读取文件…' : notice}</span>
        </span>
        {!remoteUrl && !imageFile && !imageDataUrl && <TabsList aria-label="文件查看方式" className="artifact-view-switch">
          <TabsTrigger value="preview" aria-label="预览" title="预览" disabled={content === undefined}><Eye size={14}/></TabsTrigger>
          <TabsTrigger value="source" aria-label="源码" title="源码" disabled={content === undefined}><Code2 size={14}/></TabsTrigger>
        </TabsList>}
        <div className="artifact-toolbar-actions">
          {remoteUrl ? <>
            <Button size="icon-sm" variant="ghost" aria-label="系统浏览器打开" title="系统浏览器打开" disabled={busy} onClick={() => void action(() => openExternalUrl(remoteUrl))}><ExternalLink/></Button>
            <Button size="icon-sm" variant="ghost" aria-label="刷新网页" title="刷新网页" onClick={() => setRefresh(n => n + 1)}><RefreshCw/></Button>
          </> : artifact.path ? <>
            <Button size="icon-sm" variant="ghost" aria-label="系统打开" title="系统打开" disabled={busy} onClick={() => void action(() => openArtifact(artifact.directory, artifact.path!))}><ExternalLink/></Button>
            <Button size="icon-sm" variant="ghost" aria-label="Finder" title="在 Finder 中显示" disabled={busy} onClick={() => void action(() => openArtifact(artifact.directory, artifact.path!, true))}><FolderOpen/></Button>
            <Button size="icon-sm" variant="ghost" aria-label="刷新文件" title="重新读取磁盘上的文件" disabled={reading} onClick={() => setRefresh(n => n + 1)}><RefreshCw className={reading ? 'animate-spin motion-reduce:animate-none' : undefined}/></Button>
          </> : <Button size="icon-sm" variant="ghost" aria-label="另存为" title="另存为" disabled={busy || content === undefined} onClick={() => void action(async () => {
            const path = await saveArtifact(artifact.name, content!)
            if (path && isDesktop) { try { await onSaved?.(artifact, path) } catch { throw new Error(`文件已保存到 ${path}，但产物记录保存失败，请重试。`) } }
            return path
          }, '已保存文件')}><Save/></Button>}
          <Button size="icon-sm" variant="ghost" aria-label={remoteUrl ? '复制链接' : imageFile || imageDataUrl ? '复制文件路径' : '复制文件内容'} title={remoteUrl ? '复制链接' : imageFile || imageDataUrl ? '复制文件路径' : '复制文件内容'} disabled={(!remoteUrl && !imageFile && !imageDataUrl && content === undefined) || busy} onClick={() => void action(() => navigator.clipboard.writeText(remoteUrl || (imageFile || imageDataUrl ? location : content!)), '已复制')}><Copy/></Button>
        </div>
      </div>
      {actionError && <p className="artifact-error" role="alert">{actionError}</p>}
      {error && <div className="artifact-load-state" role="alert"><p>{content !== undefined || imageDataUrl ? `刷新失败，仍显示上次读取的内容：${error}` : error}</p><Button variant="outline" size="sm" disabled={reading} onClick={() => setRefresh(n => n + 1)}>重新读取</Button></div>}
      {imageFile && reading && !imageDataUrl && <div className="artifact-load-state" role="status">正在读取图片…</div>}
      {!remoteUrl && imageDataUrl && <ArtifactImage key={`${artifact.id}:${revision}`} src={imageDataUrl} name={artifact.name} onRetry={() => setRefresh(n => n + 1)} reading={reading}/>}
      {remoteUrl && <div className="artifact-remote-content"><iframe key={`${remoteUrl}:${refresh}`} title={`${artifact.name} 网页预览`} src={remoteUrl} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" onError={() => setError('网页未能加载，可刷新重试或使用系统浏览器打开。')}/></div>}
      {!remoteUrl && content !== undefined && <>
        <TabsContent value="preview" className="artifact-preview-content">{artifact.kind === 'html' ? <iframe key={revision} title={`${artifact.name} HTML 预览`} sandbox="" referrerPolicy="no-referrer" srcDoc={html}/> : artifact.kind === 'markdown' ? <div className="artifact-markdown"><MarkdownMessage text={content} onOpenLink={onOpenLink}/></div> : <pre tabIndex={0}>{content}</pre>}</TabsContent>
        <TabsContent value="source" className="artifact-preview-content"><pre tabIndex={0}>{content}</pre></TabsContent>
      </>}
    </Tabs>
    <footer className="artifact-preview-footer">{remoteUrl ? '远程网页 · 若页面空白、限制内嵌或需要登录，请用系统浏览器打开' : artifact.kind === 'html' ? 'HTML 静态预览 · 系统打开可查看脚本与外部资源' : artifact.content !== undefined ? '内容保存在任务回复中，可另存为本地文件' : '本地文件 · 显示磁盘当前内容'}</footer>
  </aside>
}

function ArtifactImage({ src, name, onRetry, reading }: { src: string; name: string; onRetry: () => void; reading: boolean }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  return <div className="artifact-image-preview" aria-busy={status === 'loading'}>
    {status === 'loading' && <div className="artifact-image-state" role="status">正在加载图片…</div>}
    {status === 'error' ? <div className="artifact-load-state" role="alert"><p>图片无法解码，文件可能已损坏或格式不受支持。</p><Button variant="outline" size="sm" disabled={reading} onClick={onRetry}>重新读取</Button></div> : <img src={src} alt={name} className={status === 'ready' ? 'is-ready' : undefined} onLoad={() => setStatus('ready')} onError={() => setStatus('error')}/>}
  </div>
}
