import type { Paragraph, Root } from 'mdast'

const alertTitles = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
} as const

const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n|$)/
const sourceMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r\n?|\n|$)/

/** GitHub alerts are standalone blockquotes, never nested in another element. */
export function remarkGithubAlerts() {
  return (tree: Root, file?: { value?: unknown }) => {
    for (const quote of tree.children) {
      if (quote.type !== 'blockquote') continue
      const paragraph = quote.children[0]
      if (paragraph?.type !== 'paragraph') continue
      const first = paragraph.children[0]
      if (first?.type !== 'text') continue
      const match = alertMarker.exec(first.value)
      if (!match) continue

      // A text node can end immediately before same-line emphasis or a link.
      // Only a paragraph boundary or a hard break makes that marker standalone.
      const hardBreak = !match[2] && paragraph.children[1]?.type === 'break'
      if (!match[2] && paragraph.children.length > 1 && !hardBreak) continue

      // Parsing removes escapes and character references. Keep those authored
      // examples literal rather than turning them into an alert after decoding.
      const offset = first.position?.start.offset
      if (typeof file?.value === 'string' && offset !== undefined && !sourceMarker.test(file.value.slice(offset))) continue

      const type = match[1] as keyof typeof alertTitles
      first.value = first.value.slice(match[0].length)
      if (hardBreak) paragraph.children.splice(1, 1)
      if (!first.value) paragraph.children.shift()
      if (!paragraph.children.length) quote.children.shift()

      const title: Paragraph = { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: alertTitles[type] }] }] }
      quote.children.unshift(title)
      const properties = quote.data?.hProperties as Record<string, unknown> | undefined
      quote.data = { ...quote.data, hProperties: { ...properties, 'data-markdown-alert': type.toLowerCase() } }
    }
  }
}
