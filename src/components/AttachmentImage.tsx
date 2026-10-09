import { useEffect, useRef, useState } from 'react'
import { ImageOff, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { readAttachmentImage, type AttachmentFile } from '@/lib/attachments'
import './attachment-image.css'

/** Local user attachment preview. The same decoded source powers thumbnail and full-size view. */
export function AttachmentImage({ file, compact = false, onRemove }: { file: AttachmentFile; compact?: boolean; onRemove?: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; src?: string; error?: string; loaded?: boolean }>()
  const key = JSON.stringify([file.path, attempt])
  const current = result?.key === key ? result : undefined
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!container.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let active = true
    void readAttachmentImage(file.path).then(src => {
      if (active) setResult({ key, src })
    }).catch(error => {
      if (active) setResult({ key, error: String(error).replace(/^Error: /, '') })
    })
    return () => { active = false }
  }, [file.path, key, visible])

  return <div ref={container} className={`attachment-image ${compact ? 'attachment-image-compact' : ''}`}>
    <Dialog open={open} onOpenChange={setOpen}>
      {current?.error ? <div className="attachment-image-failure" role="status">
        <ImageOff size={20} aria-hidden="true" /><span>图片无法预览</span>
        <span className="sr-only">{current.error}</span>
        <Button variant="ghost" size="sm" aria-label={`重新加载图片 ${file.name}`} title={current.error} onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} />重试</Button>
      </div> : <DialogTrigger asChild><Button variant="ghost" className="attachment-image-view" aria-label={`预览图片 ${file.name}`} title={`放大查看 ${file.name}`} disabled={!current?.loaded} aria-busy={!current?.loaded}>
        {current?.src && <img src={current.src} alt={file.name} decoding="async" onLoad={() => setResult(value => value?.key === key ? { ...value, loaded: true } : value)} onError={() => setResult({ key, error: '图片内容无法解码，请检查文件后重试。' })} />}
        {!current?.loaded && <span className="attachment-image-loading" role="status"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /><span className="sr-only">正在读取图片 {file.name}</span></span>}
      </Button></DialogTrigger>}
      <DialogContent className="attachment-image-dialog" showCloseButton={false}>
        <div className="attachment-image-heading"><DialogTitle title={file.name}>{file.name}</DialogTitle><DialogClose asChild><Button variant="ghost" size="icon-sm" aria-label="关闭图片预览" title="关闭图片预览"><X /></Button></DialogClose></div>
        <DialogDescription className="sr-only">图片放大预览，按 Escape 关闭并返回缩略图。</DialogDescription>
        {current?.src && <img className="attachment-image-full" src={current.src} alt={file.name} />}
      </DialogContent>
    </Dialog>
    {onRemove && <Button className="attachment-image-remove" variant="secondary" size="icon-sm" aria-label={`移除附件 ${file.name}`} title={`移除附件 ${file.name}`} onClick={onRemove}><X size={14} /></Button>}
  </div>
}
