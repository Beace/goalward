import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Code2, Copy, ExternalLink, Eye, FolderOpen, RefreshCw, Save } from 'lucide-react'
import { Button } from './ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { MarkdownMessage } from './MarkdownMessage'
import { FileIcon } from './FileIcon'
import { htmlPreviewDocument, type Artifact } from '@/lib/artifacts'
import { isDesktop, openArtifact, readArtifact, saveArtifact, normalizeExternalHttpUrl, openExternalUrl } from '@/lib/bridge'
import './artifacts.css'
import { useI18n } from '@/i18n'

export function ArtifactPreview({ artifact, onSaved, onOpenLink }: { artifact: Artifact; onOpenLink?: (href: string) => void; onSaved?: (artifact: Artifact, path: string) => Promise<void> }) {
  const { t, language } = useI18n()
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
    if (artifact.url) { setReading(false); if (!remoteUrl) setError(t('此网页链接无效。', 'This web link is invalid.')) }
    else if (artifact.content !== undefined) { setContent(artifact.content); setReading(false) }
    else if (artifact.path) {
      setReading(true)
      void readArtifact(artifact.directory, artifact.path).then(file => {
        if (!active) return
        setContent(file.imageDataUrl ? undefined : file.content); setImageDataUrl(file.imageDataUrl); setRevision(n => n + 1)
        if (!changed) setNotice(t(`已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, `Refreshed · ${new Date().toLocaleTimeString('en-US', { hour12: false })}`))
      }).catch(error => { if (active) setError(String(error).replace(/^Error: /, '')) })
        .finally(() => { if (active) setReading(false) })
    }
    return () => { active = false }
  }, [artifact.id, artifact.content, artifact.path, artifact.directory, artifact.url, remoteUrl, refresh, language, t])
  const html = useMemo(() => artifact.kind === 'html' && content !== undefined ? htmlPreviewDocument(content) : '', [artifact.kind, content])
  async function action(work: () => Promise<unknown>, success = '') {
    setBusy(true); setActionError(''); setNotice('')
    try { const result = await work(); if (result !== null) setNotice(success) } catch (error) { setActionError(String(error).replace(/^Error: /, '')) } finally { setBusy(false) }
  }
  const location = artifact.url ?? (artifact.path ? artifact.path.startsWith('/') ? artifact.path : `${artifact.directory}/${artifact.path}` : t('回复中的文件内容', 'File content in reply'))
  return <aside className="artifact-preview" aria-label={t('产物预览', 'Artifact preview')}>
    <Tabs value={mode} onValueChange={setMode} className="artifact-preview-tabs">
      <div className="artifact-toolbar" aria-label={t('产物操作', 'Artifact actions')}>
        <FileIcon name={artifact.name} kind={artifact.kind}/>
        <h2 ref={heading} tabIndex={-1} title={`${artifact.name}\n${location}`}>{artifact.name}</h2>
        <span className="artifact-toolbar-status" role="status" title={reading ? t('正在重新读取文件…', 'Reloading file…') : notice}>
          {notice && !reading && <Check size={12} aria-hidden="true"/>}<span className="sr-only">{reading ? t('正在重新读取文件…', 'Reloading file…') : notice}</span>
        </span>
        {!remoteUrl && !imageFile && !imageDataUrl && <TabsList aria-label={t('文件查看方式', 'File view mode')} className="artifact-view-switch">
          <TabsTrigger value="preview" aria-label={t('预览', 'Preview')} title={t('预览', 'Preview')} disabled={content === undefined}><Eye size={14}/></TabsTrigger>
          <TabsTrigger value="source" aria-label={t('源码', 'Source')} title={t('源码', 'Source')} disabled={content === undefined}><Code2 size={14}/></TabsTrigger>
        </TabsList>}
        <div className="artifact-toolbar-actions">
          {remoteUrl ? <>
            <Button size="icon-sm" variant="ghost" aria-label={t('系统浏览器打开', 'Open in system browser')} title={t('系统浏览器打开', 'Open in system browser')} disabled={busy} onClick={() => void action(() => openExternalUrl(remoteUrl))}><ExternalLink/></Button>
            <Button size="icon-sm" variant="ghost" aria-label={t('刷新网页', 'Refresh web page')} title={t('刷新网页', 'Refresh web page')} onClick={() => setRefresh(n => n + 1)}><RefreshCw/></Button>
          </> : artifact.path ? <>
            <Button size="icon-sm" variant="ghost" aria-label={t('系统打开', 'Open with system app')} title={t('系统打开', 'Open with system app')} disabled={busy} onClick={() => void action(() => openArtifact(artifact.directory, artifact.path!))}><ExternalLink/></Button>
            <Button size="icon-sm" variant="ghost" aria-label="Finder" title={t('在 Finder 中显示', 'Show in Finder')} disabled={busy} onClick={() => void action(() => openArtifact(artifact.directory, artifact.path!, true))}><FolderOpen/></Button>
            <Button size="icon-sm" variant="ghost" aria-label={t('刷新文件', 'Refresh file')} title={t('重新读取磁盘上的文件', 'Reload file from disk')} disabled={reading} onClick={() => setRefresh(n => n + 1)}><RefreshCw className={reading ? 'animate-spin motion-reduce:animate-none' : undefined}/></Button>
          </> : <Button size="icon-sm" variant="ghost" aria-label={t('另存为', 'Save as')} title={t('另存为', 'Save as')} disabled={busy || content === undefined} onClick={() => void action(async () => {
            const path = await saveArtifact(artifact.name, content!)
            if (path && isDesktop) { try { await onSaved?.(artifact, path) } catch { throw new Error(t(`文件已保存到 ${path}，但产物记录保存失败，请重试。`, `File saved to ${path}, but the artifact record could not be saved. Try again.`)) } }
            return path
          }, t('已保存文件', 'File saved'))}><Save/></Button>}
          <Button size="icon-sm" variant="ghost" aria-label={remoteUrl ? t('复制链接', 'Copy link') : imageFile || imageDataUrl ? t('复制文件路径', 'Copy file path') : t('复制文件内容', 'Copy file content')} title={remoteUrl ? t('复制链接', 'Copy link') : imageFile || imageDataUrl ? t('复制文件路径', 'Copy file path') : t('复制文件内容', 'Copy file content')} disabled={(!remoteUrl && !imageFile && !imageDataUrl && content === undefined) || busy} onClick={() => void action(() => navigator.clipboard.writeText(remoteUrl || (imageFile || imageDataUrl ? location : content!)), t('已复制', 'Copied'))}><Copy/></Button>
        </div>
      </div>
      {actionError && <p className="artifact-error" role="alert">{actionError}</p>}
      {error && <div className="artifact-load-state" role="alert"><p>{content !== undefined || imageDataUrl ? t(`刷新失败，仍显示上次读取的内容：${error}`, `Refresh failed; showing the previously loaded content: ${error}`) : error}</p><Button variant="outline" size="sm" disabled={reading} onClick={() => setRefresh(n => n + 1)}>{t('重新读取', 'Reload')}</Button></div>}
      {imageFile && reading && !imageDataUrl && <div className="artifact-load-state" role="status">{t('正在读取图片…', 'Reading image…')}</div>}
      {!remoteUrl && imageDataUrl && <ArtifactImage key={`${artifact.id}:${revision}`} src={imageDataUrl} name={artifact.name} onRetry={() => setRefresh(n => n + 1)} reading={reading}/>}
      {remoteUrl && <div className="artifact-remote-content"><iframe key={`${remoteUrl}:${refresh}`} title={`${artifact.name} ${t('网页预览', 'web preview')}`} src={remoteUrl} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" onError={() => setError(t('网页未能加载，可刷新重试或使用系统浏览器打开。', 'Web page could not load. Refresh or open it in your system browser.'))}/></div>}
      {!remoteUrl && content !== undefined && <>
        <TabsContent value="preview" className="artifact-preview-content">{artifact.kind === 'html' ? <iframe key={revision} title={`${artifact.name} HTML ${t('预览', 'preview')}`} sandbox="" referrerPolicy="no-referrer" srcDoc={html}/> : artifact.kind === 'markdown' ? <div className="artifact-markdown"><MarkdownMessage text={content} onOpenLink={onOpenLink}/></div> : <pre tabIndex={0}>{content}</pre>}</TabsContent>
        <TabsContent value="source" className="artifact-preview-content"><pre tabIndex={0}>{content}</pre></TabsContent>
      </>}
    </Tabs>
    <footer className="artifact-preview-footer">{remoteUrl ? t('远程网页 · 若页面空白、限制内嵌或需要登录，请用系统浏览器打开', 'Remote web page · If blank, blocked from embedding, or requiring sign-in, open it in your system browser') : artifact.kind === 'html' ? t('HTML 静态预览 · 系统打开可查看脚本与外部资源', 'Static HTML preview · Open with a system app to view scripts and external resources') : artifact.content !== undefined ? t('内容保存在任务回复中，可另存为本地文件', 'Content is saved in the task reply and can be saved as a local file') : t('本地文件 · 显示磁盘当前内容', 'Local file · Showing current content on disk')}</footer>
  </aside>
}

function ArtifactImage({ src, name, onRetry, reading }: { src: string; name: string; onRetry: () => void; reading: boolean }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  return <div className="artifact-image-preview" aria-busy={status === 'loading'}>
    {status === 'loading' && <div className="artifact-image-state" role="status">{t('正在加载图片…', 'Loading image…')}</div>}
    {status === 'error' ? <div className="artifact-load-state" role="alert"><p>{t('图片无法解码，文件可能已损坏或格式不受支持。', 'Image could not be decoded. The file may be damaged or unsupported.')}</p><Button variant="outline" size="sm" disabled={reading} onClick={onRetry}>{t('重新读取', 'Reload')}</Button></div> : <img src={src} alt={name} className={status === 'ready' ? 'is-ready' : undefined} onLoad={() => setStatus('ready')} onError={() => setStatus('error')}/>}
  </div>
}
