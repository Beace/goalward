import { useMemo } from 'react'
import { isImageAttachment, splitAttachmentMessage } from '@/lib/attachments'
import { AttachmentImage } from './AttachmentImage'
import { FileIcon } from './FileIcon'

export function UserMessage({ text }: { text: string }) {
  const message = useMemo(() => splitAttachmentMessage(text), [text])
  return <>
    {message.text && <div>{message.text}</div>}
    {message.attachments.length > 0 && <div className="user-message-attachments" role="group" aria-label="消息附件">
      {message.attachments.map((file, index) => isImageAttachment(file)
        ? <AttachmentImage key={`${file.path}:${index}`} file={file} />
        : <span key={`${file.path}:${index}`} className="user-message-file" title={`${file.name}\n${file.path}`} tabIndex={0}><FileIcon name={file.name} /><span>{file.name}</span></span>)}
    </div>}
  </>
}
