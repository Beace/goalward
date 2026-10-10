import type { Task } from './types'
import { artifactHref, localPath, markdownArtifactHrefs } from './markdown-links'
import { normalizeExternalHttpUrl } from './bridge'
import { getTraceDisplayEntries } from './trace-calls'
import { getCurrentLanguage, translate } from '@/i18n'

export interface Artifact {
  id: string; name: string; kind: 'html' | 'markdown' | 'text' | 'file' | 'web'
  path?: string; url?: string; content?: string; directory: string
  runId?: string; memberId?: string; sourceId: string; createdAt: string
  source: 'reply' | 'tool' | 'inline' | 'saved'
}
export function artifactKind(name: string): Artifact['kind'] {
  const ext = name.split('.').at(-1)?.toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown') return 'markdown'
  return /^(txt|json|jsonl|csv|tsv|xml|yaml|yml|toml|log|css|js|jsx|ts|tsx|py|rs|go|sh|sql|svg)$/.test(ext ?? '') ? 'text' : 'file'
}
function pathKey(path: string, directory: string) {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${directory}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}
export function replyPaths(text: string): string[] {
  return markdownArtifactHrefs(text).filter(href => !normalizeExternalHttpUrl(href))
}
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function toolPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toolPaths)
  const record = object(value)
  if (!record || record.kind === 'delete' || record.type === 'delete') return []
  return Object.entries(record).flatMap(([key, value]) => {
    if (['path', 'file_path', 'filePath', 'notebook_path'].includes(key) && typeof value === 'string') return localPath(value, false) ?? []
    return value && typeof value === 'object' ? toolPaths(value) : []
  })
}
// Tasks in app state are immutable snapshots. A changed message, trace, saved
// artifact or directory produces a new task; revisiting a snapshot reuses its index.
const artifactCache = new WeakMap<Task, { zh?: Artifact[]; en?: Artifact[] }>()
export function getTaskArtifacts(task: Task): Artifact[] {
  if (task.demo) return []
  const language = getCurrentLanguage()
  const cached = artifactCache.get(task)?.[language]
  if (cached) return cached
  const artifacts = buildTaskArtifacts(task)
  artifactCache.set(task, { ...artifactCache.get(task), [language]: artifacts })
  return artifacts
}

/** A deterministic index of persisted messages + trace. Old tasks are backfilled on read.
 * Local references are NOT claims that a file exists or was successfully generated.
 */
function buildTaskArtifacts(task: Task): Artifact[] {
  const artifacts = new Map<string, Artifact>()
  const saved = new Map((task.artifacts ?? []).map(item => [item.sourceId, item]))
  const add = (item: Omit<Artifact, 'id' | 'name' | 'kind'> & { name?: string; kind?: Artifact['kind'] }) => {
    const retained = saved.get(item.sourceId)
    if (retained && item.source === 'inline') { artifacts.set(retained.id, retained); return }
    const name = item.name ?? item.path?.split('/').at(-1) ?? (item.url ? new URL(item.url).hostname : translate('未命名文件', 'Untitled file'))
    const id = item.url ? JSON.stringify([task.id, item.runId, item.url]) : item.path ? JSON.stringify([task.id, item.runId, pathKey(item.path, item.directory)]) : JSON.stringify([task.id, item.sourceId])
    const previous = artifacts.get(id)
    if (previous?.source === 'tool' && item.source === 'reply') return
    artifacts.set(id, { ...item, id, name, kind: item.kind ?? (item.url ? 'web' : artifactKind(name)) })
  }
  for (const message of task.messages) {
    if (message.role !== 'assistant' || message.kind === 'reasoning') continue
    const run = task.runs.find(run => run.id === message.runId)
    const base = { directory: run?.directory ?? task.directory, runId: message.runId, memberId: message.memberId, sourceId: message.id, createdAt: message.createdAt }
    let block = 0
    const proseLines: string[] = []
    const lines = message.text.split('\n')
    for (let line = 0; line < lines.length; line++) {
      const opening = lines[line].match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!opening) { proseLines.push(lines[line]); continue }
      const fence = opening[1]
      const info = opening[2].trim().match(/^(html?|markdown|md)\b(.*)$/i)
      const start = ++line
      while (line < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[line])) line++
      if (!info || line === lines.length) continue
      block++
      const kind = /^html?$/i.test(info[1]) ? 'html' : 'markdown'
      const provided = info[2].trim().replace(/^(?:filename|title)=/, '').replace(/^["']|["']$/g, '')
      const name = localPath(provided)?.split('/').at(-1) ?? translate(`回复文档-${block}.${kind === 'html' ? 'html' : 'md'}`, `Response document-${block}.${kind === 'html' ? 'html' : 'md'}`)
      add({ ...base, sourceId: `${message.id}:block:${block}`, source: 'inline', name, kind, content: lines.slice(start, line).join('\n') + '\n' })
    }
    const prose = proseLines.join('\n')
    if (!message.streaming && /^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(message.text) && /<\/html>\s*$/i.test(message.text)) {
      add({ ...base, source: 'inline', name: translate('回复文档.html', 'Response document.html'), kind: 'html', content: message.text })
    } else {
      for (const href of markdownArtifactHrefs(prose)) {
        const url = normalizeExternalHttpUrl(href)
        add({ ...base, ...(url ? { url } : { path: href }), source: 'reply' })
      }
    }
  }
  for (const entry of getTraceDisplayEntries(task)) {
    if (!entry.call || entry.call.status !== 'completed' || entry.category !== 'file-change') continue
    const run = task.runs.find(run => run.id === entry.runId)
    const paths = [...toolPaths(entry.call.input), ...toolPaths(entry.call.output)]
    for (const record of entry.call.records) {
      try {
        const payload = JSON.parse(record.text)
        if (payload.type === 'kimi.acp.update') paths.push(...toolPaths(payload.update?.locations))
      } catch { /* malformed raw records stay in trace */ }
    }
    for (const path of new Set(paths)) add({ path, source: 'tool', directory: run?.directory ?? task.directory, runId: entry.runId, memberId: entry.memberId, sourceId: entry.id, createdAt: entry.call.endedAt ?? entry.timestamp })
  }
  for (const item of saved.values()) artifacts.set(item.id, item)
  return [...artifacts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Creates a preview for links not already indexed (for example inside a Markdown file). */
export function artifactFromLink(href: string, context: Pick<Artifact, 'directory' | 'runId' | 'memberId' | 'sourceId' | 'createdAt'>, taskId: string): Artifact | undefined {
  const target = artifactHref(href)
  if (!target) return
  const url = normalizeExternalHttpUrl(target)
  const name = url ? new URL(url).hostname : target.split('/').at(-1) || target
  return { ...context, id: JSON.stringify([taskId, context.runId, url ?? pathKey(target, context.directory)]), name, kind: url ? 'web' : artifactKind(name), ...(url ? { url } : { path: pathKey(target, context.directory) }), source: 'reply' }
}

/** Scripts, navigation and external resources cannot escape the preview. */
export function htmlPreviewDocument(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html')
  document.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv], link, form').forEach(node => node.remove())
  document.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || ['href', 'action', 'formaction', 'srcdoc', 'target', 'ping', 'download'].includes(attr.name)) node.removeAttribute(attr.name)
    }
  })
  const csp = document.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"
  document.head.prepend(csp)
  return '<!doctype html>\n' + document.documentElement.outerHTML
}
