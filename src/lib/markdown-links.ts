import type { Root, Nodes, Parent, PhrasingContent } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { normalizeExternalHttpUrl } from './bridge'

/** Local references are resolved by Rust only after a user opens the preview. */
export function localPath(value: string, requireExtension = true): string | undefined {
  let path = value.trim().replace(/^<|>$/g, '')
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return
      path = decodeURIComponent(url.pathname)
    } catch { return }
  } else {
    // Markdown encodes spaces in link destinations. Decode once, before validation.
    try { path = decodeURIComponent(path) } catch { /* Literal percent signs are valid filenames. */ }
  }
  path = path.replace(/[?#].*$/, '').replace(/:\d+(?::\d+)?$/, '')
  if (!path || /[\u0000-\u001f\u007f<>]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) return
  if (requireExtension && !/\.[a-z0-9]{1,12}$/i.test(path)) return
  if (requireExtension && !path.includes('/') && (!/\.(?:html?|md|markdown|mdown|txt|jsonl?|csv|tsv|xml|ya?ml|toml|css|[cm]?js|jsx|tsx?|py|rs|go|sh|sql|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|webp|gif|zip|mp[34]|wav)$/i.test(path) || /\s/.test(path))) return
  return path.replace(/^\.\//, '')
}

export function artifactHref(value: string, explicit = true): string | undefined {
  if (value.startsWith('#')) return
  const url = normalizeExternalHttpUrl(value)
  if (url) return url
  // A filename mentioned in prose or inline code does not establish its location.
  // Require directory syntax before localPath strips './'; explicit Markdown
  // destinations and structured tool paths can still refer to root-level files.
  if (!explicit && !/\/|%2f/i.test(value)) return
  return localPath(value, !explicit)
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node)
  if ('children' in node) node.children.forEach(child => walk(child, visit))
}

/** Linkify paths without touching fenced code, HTML, or existing link labels. */
export function remarkArtifactLinks() {
  return (tree: Root) => {
    const transform = (parent: Parent) => {
      parent.children = parent.children.flatMap((node): typeof parent.children => {
        if (['link', 'linkReference', 'code', 'html', 'definition'].includes(node.type)) return [node]
        if (node.type === 'inlineCode') {
          const url = artifactHref(node.value, false)
          return url ? [{ type: 'link', url, children: [node] }] : [node]
        }
        if (node.type === 'text') {
          const parts: PhrasingContent[] = []
          let offset = 0
          const paths = /(?:^|[\s（(：])((?:\/|\.\/|\.\.\/|~\/)?[\w\u4e00-\u9fff@-]+(?:\/[\w\u4e00-\u9fff.@-]+)*\.(?:html?|md|markdown|txt|json|csv|pdf|png|jpe?g|svg|webp|zip)(?::\d+(?::\d+)?)?)(?=$|[\s，。；：、)）,;!?])/gi
          for (const match of node.value.matchAll(paths)) {
            const start = match.index! + match[0].length - match[1].length
            const url = artifactHref(match[1], false)
            if (!url) continue
            if (start > offset) parts.push({ type: 'text', value: node.value.slice(offset, start) })
            parts.push({ type: 'link', url, children: [{ type: 'text', value: match[1] }] })
            offset = start + match[1].length
          }
          if (!parts.length) return [node]
          if (offset < node.value.length) parts.push({ type: 'text', value: node.value.slice(offset) })
          return parts
        }
        if ('children' in node) transform(node)
        return [node]
      })
    }
    transform(tree)
  }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkArtifactLinks)

/** Shares the renderer's AST rules, including reference links and inline code paths. */
export function markdownArtifactHrefs(text: string): string[] {
  const tree = parser.runSync(parser.parse(text)) as Root
  const definitions = new Map<string, string>()
  walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier, node.url) })
  const hrefs = new Set<string>()
  walk(tree, node => {
    const value = node.type === 'link' || node.type === 'image' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier) : undefined
    const href = value && artifactHref(value)
    if (href) hrefs.add(href)
  })
  return [...hrefs]
}
