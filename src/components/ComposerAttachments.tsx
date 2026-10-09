import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isImageAttachment, type DraftAttachment } from '@/lib/attachments'
import { FileIcon } from './FileIcon'
import { AttachmentImage } from './AttachmentImage'

export function ComposerAttachments({ attachments, importing, onRemove }: { attachments: DraftAttachment[]; importing: boolean; onRemove: (id: string) => void }) {
  const images = attachments.filter(isImageAttachment)
  const files = attachments.filter(file => !isImageAttachment(file))
  return <>
    {images.length > 0 && <ul className="composer-images" aria-label="待发送图片">{images.map(file => <li key={file.id}><AttachmentImage file={file} compact onRemove={() => onRemove(file.id)} /></li>)}</ul>}
    {files.length > 0 && <TooltipProvider><ul className="composer-attachments" aria-label="待发送附件">
      {files.map(file => <li key={file.id} className="composer-attachment">
        <FileIcon name={file.name} />
        <Tooltip><TooltipTrigger asChild><span className="composer-attachment-details" tabIndex={0}>
          <span className="composer-attachment-name">{file.name}</span><span className="composer-attachment-path">{file.path}</span>
        </span></TooltipTrigger><TooltipContent className="artifact-details-tooltip"><div>{file.name}</div><div>{file.path}</div></TooltipContent></Tooltip>
        <Button variant="ghost" size="icon-sm" aria-label={`移除附件 ${file.name}`} title={`移除附件 ${file.name}`} onClick={() => onRemove(file.id)}><X size={14} /></Button>
      </li>)}
    </ul></TooltipProvider>}
    <span className={importing ? 'composer-importing' : 'sr-only'} role="status" aria-live="polite">{importing ? <><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />正在添加附件…</> : attachments.length ? `已添加 ${attachments.length} 个附件` : ''}</span>
  </>
}
