import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type Ref, type KeyboardEvent } from 'react'
import { Folder } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Spinner } from '@/components/ui/spinner'
import { FileIcon } from './FileIcon'
import { insertWorkspaceReference, mentionQuery, searchWorkspaceEntries, type WorkspaceEntry } from '@/lib/workspace-references'
import { useI18n } from '@/i18n'
import './workspace-references.css'

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'ref'> & {
  value: string; onValueChange: (value: string) => void; directories: string[]; ref?: Ref<HTMLTextAreaElement>
  /** Injected only by UI verification; desktop uses the Rust metadata search. */
  search?: typeof searchWorkspaceEntries
}

/** Keep focus and the caret in the textarea. High-frequency keyboard updates
 * are immediate; reused shared controls provide pointer/pressed feedback. */
export function WorkspaceMentionInput({ value, onValueChange, directories, ref, onKeyDown, onSelect, onBlur, search = searchWorkspaceEntries, ...props }: Props) {
  const { t } = useI18n()
  const local = useRef<HTMLTextAreaElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const [caret, setCaret] = useState(value.length)
  const [dismissed, setDismissed] = useState<string>()
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [listId, setListId] = useState<string>()
  const [optionId, setOptionId] = useState<string>()
  const query = props.disabled ? undefined : mentionQuery(value, caret)
  const queryKey = query ? `${query.start}:${query.query}` : undefined
  const open = Boolean(query && queryKey !== dismissed)
  const roots = JSON.stringify(directories)
  useLayoutEffect(() => {
    // cmdk owns actual list/item IDs; bind the external textarea to those IDs
    // rather than overriding the component's accessible implementation.
    setListId(open ? menu.current?.querySelector('[cmdk-list]')?.id : undefined)
    const options = [...(menu.current?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])]
    setOptionId(open ? options.find(item => item.dataset.value === selected)?.id : undefined)
  }, [open, entries, selected])
  useEffect(() => {
    if (!open || !query) return
    let live = true
    setEntries([]); setSelected(''); setError(''); setTruncated(false)
    if (!directories.length) { setLoading(false); return }
    setLoading(true)
    void search(directories, query.query).then(result => {
      if (!live) return
      setEntries(result.entries); setSelected(result.entries[0]?.path ?? ''); setTruncated(result.truncated)
    }).catch(cause => { if (live) setError(String(cause instanceof Error ? cause.message : cause)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [open, queryKey, roots, search])

  function choose(entry: WorkspaceEntry) {
    if (!query) return
    const next = insertWorkspaceReference(value, query, entry)
    onValueChange(next.value); setCaret(next.caret); setDismissed(queryKey)
    requestAnimationFrame(() => { local.current?.focus(); local.current?.setSelectionRange(next.caret, next.caret) })
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(queryKey); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const index = entries.findIndex(entry => entry.path === selected)
        const next = entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]
        if (next) setSelected(next.path)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        const entry = entries.find(item => item.path === selected)
        if (entry) { event.preventDefault(); choose(entry); return }
        if (event.key === 'Enter') { event.preventDefault(); return }
      }
    }
    onKeyDown?.(event)
  }
  return <div className="workspace-reference-input">
    <Textarea {...props} ref={node => { local.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }} value={value}
      aria-autocomplete="list" aria-controls={listId} aria-activedescendant={optionId}
      onChange={event => { setCaret(event.currentTarget.selectionStart); setDismissed(undefined); onValueChange(event.target.value) }}
      onSelect={event => { setCaret(event.currentTarget.selectionStart); onSelect?.(event) }} onKeyDown={keyDown}
      onBlur={event => { setDismissed(queryKey); onBlur?.(event) }} />
    {open && <div ref={menu} className="workspace-reference-menu" aria-label={t('引用文件或文件夹', 'Reference a file or folder')}>
      <Command shouldFilter={false} value={selected} onValueChange={setSelected}>
        <CommandList id={id} aria-label={t('工作目录中的文件与文件夹', 'Files and folders in working directories')}>
          {entries.map((entry, index) => <CommandItem id={`${id}-${index}`} key={entry.path} value={entry.path} onSelect={() => choose(entry)} onMouseDown={event => event.preventDefault()} title={entry.path}>
            {entry.kind === 'folder' ? <Folder size={16} /> : <FileIcon name={entry.path} />}
            <span className="workspace-reference-name">{entry.name}</span><span className="workspace-reference-path">{entry.relativePath === entry.name ? entry.root : entry.relativePath}</span>
            {directories.length > 1 && <span className="workspace-reference-root" title={entry.root}>{entry.root.split('/').filter(Boolean).at(-1)}</span>}
          </CommandItem>)}
        </CommandList>
      </Command>
      {loading && <p className="workspace-reference-status" role="status"><Spinner className="size-3" />{t('正在查找文件…', 'Finding files…')}</p>}
      {error && <p className="workspace-reference-status text-destructive" role="alert">{error}</p>}
      {!loading && !error && !entries.length && <p className="workspace-reference-status" role="status">{directories.length ? t('没有匹配项，继续输入路径缩小范围。', 'No matches. Type more of the path.') : t('先在目标中添加工作目录。', 'Add a working directory to the goal first.')}</p>}
      {truncated && <p className="workspace-reference-status" role="status">{t('仅显示部分结果，继续输入文件名或路径。', 'Partial results. Type more of the file name or path.')}</p>}
    </div>}
  </div>
}
