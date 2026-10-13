// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getTaskArtifacts, htmlPreviewDocument, replyPaths } from './artifacts'
import type { Task, RuntimeEvent, Adapter } from './types'
const timestamp = '2026-09-17T09:00:00Z'
function task(text: string, events: RuntimeEvent[] = [], adapter: Adapter = 'codex'): Task {
  const member = { id: 'member', name: 'Agent', role: 'Implementation', runtimeId: adapter, modelId: '' }
  return { id: 'task', title: 'Generate document', directory: '/workspace/new', mode: 'solo', createdAt: timestamp, members: [member], messages: [{ id: 'reply', role: 'assistant', text, createdAt: timestamp, runId: 'run', memberId: 'member' }], runs: [{ id: 'run', directory: '/workspace/original', createdAt: timestamp, prompt: '', members: [{ ...member, status: 'completed', model: '', runtime: { id: adapter, name: adapter, adapter, executable: adapter, args: [], defaultModel: '', description: '', enabled: true } }] }], events }
}
function event(payload: unknown, id = 'event'): RuntimeEvent { return { id, taskId: 'task', runId: 'run', memberId: 'member', timestamp, kind: 'stdout', text: JSON.stringify(payload) } }
describe('artifact history index', () => {
  it('reuses an immutable task index and refreshes changed messages, trace and saved references', () => {
    const original = task('`./report.md`')
    const index = getTaskArtifacts(original)
    expect(getTaskArtifacts(original)).toBe(index)
    const edited = { ...original, messages: [{ ...original.messages[0], text: '`./next.md`' }] }
    expect(getTaskArtifacts(edited)[0].name).toBe('next.md')
    const completed = { ...original, events: [event({ type: 'item.completed', item: { id: 'write', type: 'file_change', changes: [{ path: 'new.html', kind: 'add' }] } })] }
    expect(getTaskArtifacts(completed).map(item => item.name)).toContain('new.html')
    const saved = { ...original, artifacts: [{ ...index[0], id: 'saved', source: 'saved' as const, path: '/saved/report.md' }] }
    expect(getTaskArtifacts(saved).some(item => item.path === '/saved/report.md')).toBe(true)
    expect(getTaskArtifacts(original)).toBe(index)
    expect(index.map(item => item.name)).toEqual(['report.md'])
  })

  it('backfills screenshot-style paths, deduplicates normalized aliases and preserves historical directory', () => {
    const artifacts = getTaskArtifacts(task('Done. Output file: `/workspace/original/business-quality.html`\n\n[Open](./business-quality.html)'))
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ name: 'business-quality.html', directory: '/workspace/original', source: 'reply', runId: 'run', memberId: 'member' })
  })
  it('keeps revisions from different executions distinct after reload', () => {
    const value = task('`./report.md`')
    value.runs.push({ ...value.runs[0], id: 'run2' })
    value.messages.push({ ...value.messages[0], id: 'reply2', runId: 'run2' })
    const artifacts = getTaskArtifacts(JSON.parse(JSON.stringify(value)))
    expect(artifacts).toHaveLength(2)
    expect(new Set(artifacts.map(a => a.id)).size).toBe(2)
  })
  it('indexes closed document fences and excludes ordinary code and partial documents', () => {
    const value = task('```html filename="résumé.html"\n<h1>Hello</h1>\n```\n```md\n# Document\n```\n```sh\ncat secret.txt\nreport.md\n```\n```html\n<h1>Incomplete')
    const artifacts = getTaskArtifacts(value)
    expect(artifacts.map(a => a.name)).toEqual(['résumé.html', '回复文档-2.md'])
    expect(artifacts[0].content).toBe('<h1>Hello</h1>\n')
  })
  it('does not collapse two document blocks with the same provided filename', () => {
    expect(getTaskArtifacts(task('```md report.md\n# v1\n```\n```md report.md\n# v2\n```'))).toHaveLength(2)
  })
  it('supports raw full HTML and Unicode paths with spaces, rejecting web/app schemes', () => {
    expect(getTaskArtifacts(task('<!doctype html><html><body>Report</body></html>'))[0].kind).toBe('html')
    expect(replyPaths('`/workspace/quality résumé.md` [Web page](https://example.com/report.html) [Blocked](javascript:report.md)')).toEqual(['/workspace/quality résumé.md'])
  })
  it('registers successful file changes, but not failed writes, deletes or reads', () => {
    const events = [event({ type: 'item.completed', item: { id: 'write', type: 'file_change', changes: [{ path: 'report.html', kind: 'add' }, { path: 'deleted.md', kind: 'delete' }] } }), event({ type: 'item.failed', item: { id: 'failed', type: 'file_change', changes: [{ path: 'failed.md', kind: 'add' }] } }, 'event2')]
    const artifacts = getTaskArtifacts(task('`./report.html`', events))
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].source).toBe('tool')
  })
  it('reads ACP edit locations across start/completion records', () => {
    const events = [event({ type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call', toolCallId: 'write', kind: 'edit', title: 'Write', status: 'in_progress', locations: [{ path: '/workspace/original/report.md' }] } }), event({ type: 'kimi.acp.update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' } }, 'done')]
    expect(getTaskArtifacts(task('', events, 'kimi'))[0]).toMatchObject({ name: 'report.md', source: 'tool' })
  })
  it('does not treat user instructions or demo records as generated artifacts', () => {
    const value = task('`./report.md`'); value.messages[0].role = 'user'
    expect(getTaskArtifacts(value)).toEqual([])
    value.demo = true; value.messages[0].role = 'assistant'
    expect(getTaskArtifacts(value)).toEqual([])
  })
  it('does not index file-like references from rendered reasoning', () => {
    const value = task('[Report](./reasoning-only.md)')
    value.messages[0].kind = 'reasoning'
    expect(getTaskArtifacts(value)).toEqual([])
  })
  it('does not invent workspace paths for filenames described inside screenshots, including restored history', () => {
    const value = task('This is a screenshot of the macOS Preview app (filename `EC02548A-60C6-41C1-B883-4BE94F15C7AF.PNG`).\n\nMentions report.md and photo.png.')
    value.directory = '/Users/bytedance/Documents/tech_news'
    value.runs[0].directory = value.directory
    expect(getTaskArtifacts(JSON.parse(JSON.stringify(value)))).toEqual([])
  })
  it('retains explicit filename links, directory paths and structured file-change evidence', () => {
    const value = task('[Report](report.md)\n\n[Image][image]\n\n[image]: photo.png\n\n`./local.md` and `docs/guide.md`\n\n`/workspace/original/image.png`', [event({ type: 'item.completed', item: { id: 'write', type: 'file_change', changes: [{ path: 'generated.png', kind: 'add' }] } })])
    expect(getTaskArtifacts(value).map(item => item.path)).toEqual(['report.md', 'photo.png', 'local.md', 'docs/guide.md', '/workspace/original/image.png', 'generated.png'])
  })
})
it('isolates HTML while preserving layout and the original source', () => {
  const source = '<html><head><style>h1 { color:red }</style><meta http-equiv="refresh" content="0;url=https://example.com"></head><body onload="alert(1)"><h1>Preview</h1><script>alert(1)</script><a href="file:///etc/passwd">link</a><iframe src="https://example.com"></iframe></body></html>'
  const rendered = new DOMParser().parseFromString(htmlPreviewDocument(source), 'text/html')
  expect(rendered.querySelector('h1')?.textContent).toBe('Preview')
  expect(rendered.querySelector('style')?.textContent).toContain('color:red')
  expect(rendered.querySelector('script, iframe, [onload], a[href]')).toBeNull()
  expect(rendered.querySelector('meta')?.content).toContain("default-src 'none'")
  expect(source).toContain('<script>')
})
it('restores saved document paths after serialization without duplicating inline artifacts', () => {
  const value = task('```markdown report.md\n# Document\n```')
  const original = getTaskArtifacts(value)[0]
  value.artifacts = [{ ...original, path: '/chosen/report.md', directory: '/chosen', content: undefined, source: 'saved' }]
  const artifacts = getTaskArtifacts(JSON.parse(JSON.stringify(value)))
  expect(artifacts).toHaveLength(1)
  expect(artifacts[0]).toMatchObject({ id: original.id, path: '/chosen/report.md', source: 'saved' })
})
it('does not mistake dotted module names in the real report reply for generated files', () => {
  expect(replyPaths('Use `html.parser` for validation and `console.log` for results. Output `/Users/bytedance/Documents/tech_news/business-quality.html`')).toEqual(['/Users/bytedance/Documents/tech_news/business-quality.html'])
})

it('indexes web links and local reference links using the same Markdown rules as the renderer', () => {
  const artifacts = getTaskArtifacts(task('[Remote](https://example.com/report?q=1)\n\n`https://example.com/report?q=1`\n\n[Document][doc]\n\n[doc]: <./docs/quality résumé.md>\n\n```text\nhttps://example.com/not-an-artifact\n```'))
  expect(artifacts).toHaveLength(2)
  expect(artifacts[0]).toMatchObject({ kind: 'web', url: 'https://example.com/report?q=1', directory: '/workspace/original' })
  expect(artifacts[1]).toMatchObject({ kind: 'markdown', path: 'docs/quality résumé.md' })
})
