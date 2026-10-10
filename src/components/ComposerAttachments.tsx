import { LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { isImageAttachment, type DraftAttachment } from '@/lib/attachments'
import { FileIcon } from './FileIcon'
import { AttachmentImage } from './AttachmentImage'
import { useI18n } from '@/i18n'

export function ComposerAttachments({ attachments, importing, onRemove }: { attachments: DraftAttachment[]; importing: boolean; onRemove: (id: string) => void }) {
  const { t } = useI18n()
  const images = attachments.filter(isImageAttachment)
  const files = attachments.filter(file => !isImageAttachment(file))
  return <>
    {images.length > 0 && <ul className="composer-images" aria-label={t('待发送图片', 'Images to send')}>{images.map(file => <li key={file.id}><AttachmentImage file={file} compact onRemove={() => onRemove(file.id)} /></li>)}</ul>}
    {files.length > 0 && <TooltipProvider><ul className="composer-attachments" aria-label={t('待发送附件', 'Attachments to send')}>
      {files.map(file => <li key={file.id} className="composer-attachment">
        <FileIcon name={file.name} />
        <Tooltip><TooltipTrigger asChild><span className="composer-attachment-details" tabIndex={0}>
          <span className="composer-attachment-name">{file.name}</span><span className="composer-attachment-path">{file.path}</span>
        </span></TooltipTrigger><TooltipContent className="artifact-details-tooltip"><div>{file.name}</div><div>{file.path}</div></TooltipContent></Tooltip>
        <Button variant="ghost" size="icon-sm" aria-label={`${t('移除附件', 'Remove attachment')} ${file.name}`} title={`${t('移除附件', 'Remove attachment')} ${file.name}`} onClick={() => onRemove(file.id)}><X size={14} /></Button>
      </li>)}
    </ul></TooltipProvider>}
    <span className={importing ? 'composer-importing' : 'sr-only'} role="status" aria-live="polite">{importing ? <><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />{t('正在添加附件…', 'Adding attachments…')}</> : attachments.length ? t(`已添加 ${attachments.length} 个附件`, `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} added`) : ''}</span>
  </>
}
