import { useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react'
import { isDesktop } from '@/lib/bridge'
import { readClipboardAttachments, type DraftAttachment } from '@/lib/attachments'

export function useComposerAttachments(input: RefObject<HTMLTextAreaElement | null>, onText: (text: string, start: number, end: number) => void, onError: (message: string) => void) {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [importing, setImporting] = useState(false)
  const pending = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (!isDesktop && !files.length) return // Preserve ordinary browser text paste.
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    const node = event.currentTarget
    const before = node.value
    const start = node.selectionStart
    const end = node.selectionEnd
    pending.current++
    setImporting(true)
    onError('')
    try {
      const imported = await readClipboardAttachments(files)
      if (!mounted.current) return
      if (imported.length) {
        setAttachments(current => {
          const next = [...current]
          for (const file of imported) if (!next.some(item => item.path === file.path)) next.push({ ...file, id: crypto.randomUUID() })
          return next
        })
      } else if (text) {
        // Keep the paste insertion point; if typing continued, use the live caret.
        const from = node.value === before ? start : node.selectionStart
        const to = node.value === before ? end : node.selectionEnd
        if (document.activeElement === node && typeof document.execCommand === 'function') {
          node.setSelectionRange(from, to)
          if (document.execCommand('insertText', false, text)) return
        }
        onText(text, from, to)
      }
    } catch (error) {
      if (mounted.current) onError(String(error).replace(/^Error: /, ''))
    } finally {
      pending.current--
      if (mounted.current) setImporting(pending.current > 0)
    }
  }

  function remove(id: string) {
    setAttachments(current => current.filter(item => item.id !== id))
    input.current?.focus()
  }
  function submitted(ids: string[]) { setAttachments(current => current.filter(item => !ids.includes(item.id))) }
  return { attachments, importing, pending, onPaste, remove, submitted }
}
