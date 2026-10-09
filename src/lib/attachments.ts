import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './bridge'

export interface AttachmentFile { name: string; path: string }
export interface DraftAttachment extends AttachmentFile { id: string }
export const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024

export function isImageAttachment(file: AttachmentFile): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/i.test(file.path)
}

export async function readAttachmentImage(path: string): Promise<string> {
  if (!isDesktop) throw new Error('请在桌面应用中预览本地图片。')
  return invoke<string>('read_attachment_image', { path })
}

/** Project the exact persisted attachment suffix into UI without changing model/history text. */
export function splitAttachmentMessage(text: string): { text: string; attachments: AttachmentFile[] } {
  const marker = '附件（本地文件路径）：\n'
  const index = text.lastIndexOf(marker)
  const unchanged = { text, attachments: [] }
  if (index < 0 || (index > 0 && text.slice(index - 2, index) !== '\n\n')) return unchanged
  const lines = text.slice(index + marker.length).trimEnd().split('\n')
  const attachments: AttachmentFile[] = []
  for (const line of lines) {
    const match = /^- ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*")$/.exec(line)
    if (!match) return unchanged
    try {
      const name: unknown = JSON.parse(match[1])
      const path: unknown = JSON.parse(match[2])
      if (typeof name !== 'string' || !name || typeof path !== 'string' || !path.startsWith('/')) return unchanged
      attachments.push({ name, path })
    } catch { return unchanged }
  }
  return { text: text.slice(0, index).trimEnd(), attachments }
}

export async function readClipboardAttachments(files: File[]): Promise<AttachmentFile[]> {
  if (!isDesktop) throw new Error('请在桌面应用中粘贴图片或文件，浏览器预览无法取得本机文件路径。')
  const native = await invoke<AttachmentFile[]>('read_clipboard_attachments')
  if (native.length) return native
  // WebKit may expose a web image/file without a corresponding native file URL.
  return Promise.all(files.map(async file => {
    if (file.size > MAX_CLIPBOARD_BYTES) throw new Error(`${file.name} 超过 32 MB，请先保存成文件，再从 Finder 复制。`)
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
      reader.readAsDataURL(file)
    })
    return invoke<AttachmentFile>('save_clipboard_file', { name: file.name || 'clipboard-file', data })
  }))
}

export function promptWithAttachments(prompt: string, attachments: AttachmentFile[]): string {
  if (!attachments.length) return prompt.trim()
  // JSON quoting preserves spaces, newlines and literal shell characters in paths.
  const references = attachments.map(file => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n')
  return `${prompt.trim() ? `${prompt.trim()}\n\n` : ''}附件（本地文件路径）：\n${references}`
}
