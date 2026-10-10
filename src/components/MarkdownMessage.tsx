import { Children, isValidElement, memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { normalizeExternalHttpUrl, openExternalUrl } from '@/lib/bridge'
import { artifactHref, remarkArtifactLinks } from '@/lib/markdown-links'
import './markdown-message.css'
import { useI18n } from '@/i18n'

/** Accept references for explicit preview; never allow executable schemes or automatic loads. */
export function markdownUrl(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) return ''
  if (value.startsWith('#')) return value
  return artifactHref(value) ?? ''
}

function MarkdownLink({ href, children, title, onOpenLink, ...attributes }: ComponentProps<'a'> & { onOpenLink?: (href: string) => void }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  const safe = href && markdownUrl(href)
  if (!safe || (!safe.startsWith('#') && !onOpenLink && !normalizeExternalHttpUrl(safe))) return <span title={title}>{children}</span>
  return <><a {...attributes} href={safe} title={title || (onOpenLink ? t(`在产物中打开：${safe}`, `Open in artifacts: ${safe}`) : safe)} target={safe.startsWith('#') || onOpenLink ? undefined : '_blank'} rel="noopener noreferrer" onClick={event => {
    event.preventDefault()
    if (safe.startsWith('#')) {
      let target = safe.slice(1)
      try { target = decodeURIComponent(target) } catch { /* Keep literal malformed fragments inert. */ }
      const element = [...(event.currentTarget.closest('.markdown-body')?.querySelectorAll('[id]') ?? [])].find(node => node.id === target)
      element?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      return
    }
    if (onOpenLink) { onOpenLink(safe); return }
    setFailed(false)
    void openExternalUrl(safe).catch(() => setFailed(true))
  }}>{children}</a>{failed && <span className="markdown-link-error" role="status">{t('链接未能打开，请重试。', 'Link could not be opened. Try again.')}</span>}</>
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const code = Children.toArray(children).find(child => isValidElement(child))
  const props = isValidElement<{ className?: string; children?: string }>(code) ? code.props : undefined
  const text = typeof props?.children === 'string' ? props.children : ''
  const language = props?.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? t('代码', 'Code')
  const isCopied = copied === text
  return <div className="markdown-code-block"><div className="markdown-code-toolbar"><span>{language}</span><Button variant="ghost" size="sm" aria-label={t('复制代码', 'Copy code')} onClick={async () => {
    setFailed(false)
    try { await navigator.clipboard.writeText(text); setCopied(text) } catch { setFailed(true) }
  }}>{isCopied ? <Check size={12} /> : <Copy size={12} />}{isCopied ? t('已复制', 'Copied') : t('复制', 'Copy')}</Button></div><pre tabIndex={0} aria-label={t(`${language}代码块`, `${language} code block`)}>{children}</pre>{failed && <span className="markdown-link-error" role="status">{t('复制失败，可选中代码手动复制。', 'Copy failed. Select the code to copy it manually.')}</span>}</div>
}

function MarkdownImageLink({ src, alt, onOpenLink }: { src?: string; alt?: string; onOpenLink?: (href: string) => void }) {
  const { t } = useI18n()
  return <MarkdownLink href={src} onOpenLink={onOpenLink}>{t(`图片：${alt || '查看图片'}`, `Image: ${alt || 'View image'}`)}</MarkdownLink>
}

const components: Components = {
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // The runtime may emit arbitrary image URLs; load only after an explicit click.
  img: ({ src, alt }) => <MarkdownImageLink src={typeof src === 'string' ? src : undefined} alt={alt ?? undefined} />,
  table: ({ node: _node, ...props }) => <Table {...props} />,
  thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
  tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
  tr: ({ node: _node, ...props }) => <TableRow {...props} />,
  th: ({ node: _node, ...props }) => <TableHead {...props} />,
  td: ({ node: _node, ...props }) => <TableCell {...props} />,
}
const plugins = [remarkGfm, remarkArtifactLinks]

/** Stable component identity keeps streamed text in the existing message. */
export const MarkdownMessage = memo(function MarkdownMessage({ text, onOpenLink }: { text: string; onOpenLink?: (href: string) => void }) {
  const { t } = useI18n()
  // Trace updates replace link closures without changing the Markdown body.
  // Retain the parser/tree, while clicks still resolve against current context.
  const linkHandler = useRef(onOpenLink)
  useLayoutEffect(() => { linkHandler.current = onOpenLink }, [onOpenLink])
  const openLink = useCallback((href: string) => linkHandler.current?.(href), [])
  const handler = onOpenLink ? openLink : undefined
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const footnoteLabel = t('注释', 'Footnotes')
  const rehypeOptions = useMemo(() => ({ clobberPrefix: `message-${id}-`, footnoteLabel }), [id, footnoteLabel])
  const scopedComponents = useMemo<Components>(() => ({
    ...components,
    a: ({ node: _node, ...props }) => <MarkdownLink {...props} onOpenLink={handler} aria-describedby={props['aria-describedby'] === 'footnote-label' ? `message-${id}-footnote-label` : props['aria-describedby']} />,
    img: ({ src, alt }) => <MarkdownImageLink src={typeof src === 'string' ? src : undefined} alt={alt ?? undefined} onOpenLink={handler} />,
    h2: ({ node: _node, ...props }) => <h2 {...props} id={props.id === 'footnote-label' ? `message-${id}-footnote-label` : props.id} />,
  }), [id, handler])
  return useMemo(() => <div className="markdown-body"><Markdown remarkPlugins={plugins} remarkRehypeOptions={rehypeOptions} components={scopedComponents} urlTransform={markdownUrl}>{text}</Markdown></div>, [text, rehypeOptions, scopedComponents])
})
