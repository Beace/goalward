// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'

const bridge = vi.hoisted(() => ({ openExternalUrl: vi.fn() }))
vi.mock('@/lib/bridge', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/bridge')>(), ...bridge }))
const writeText = vi.fn()
const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  bridge.openExternalUrl.mockResolvedValue(undefined)
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
})
afterEach(cleanup)

describe('MarkdownMessage content', () => {
  it('retains unchanged content and copy state when only the link callback changes', async () => {
    const first = vi.fn(), latest = vi.fn()
    const text = '[报告](./report.md)\n\n```sh\necho hello\n```'
    const view = render(<MarkdownMessage text={text} onOpenLink={first} />)
    const link = screen.getByRole('link', { name: '报告' })
    const code = screen.getByLabelText('sh代码块')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(screen.getByText('已复制')).toBeTruthy())
    view.rerender(<MarkdownMessage text={text} onOpenLink={latest} />)
    expect(screen.getByRole('link', { name: '报告' })).toBe(link)
    expect(screen.getByLabelText('sh代码块')).toBe(code)
    expect(screen.getByText('已复制')).toBeTruthy()
    fireEvent.click(link)
    expect(latest).toHaveBeenCalledWith('report.md')
    expect(first).not.toHaveBeenCalled()
    view.rerender(<MarkdownMessage text={text + '\n新增正文'} onOpenLink={latest} />)
    expect(screen.getByText('新增正文')).toBeTruthy()
    view.rerender(<MarkdownMessage text={text} />)
    expect(screen.queryByRole('link', { name: '报告' })).toBeNull()
  })
  it('renders headings, emphasis, inline code, quotes and real nested ordered lists', () => {
    const { container } = render(<MarkdownMessage text={'# 新闻摘要\n\n**关键结论**，包含 `agent.run()`。\n\n1. 收集来源\n   1. 核对日期\n   2. 检查原文\n2. 整理报告\n\n> 引用的公开内容'} />)
    expect(screen.getByRole('heading', { level: 1, name: '新闻摘要' })).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('关键结论')
    expect(container.querySelector('code')?.textContent).toBe('agent.run()')
    const list = container.querySelector('ol')!
    expect(list.children).toHaveLength(2)
    expect(list.querySelector('li > ol')?.children).toHaveLength(2)
    expect(list.querySelector('li > ol > li')?.textContent).toBe('核对日期')
    expect(container.querySelector('blockquote')?.textContent).toContain('引用的公开内容')
  })

  it('renders GFM tables, task checkboxes and strikethrough with semantic DOM', () => {
    const { container } = render(<MarkdownMessage text={'| 来源 | 日期 |\n| --- | --- |\n| 官方公告 | 09-16 |\n\n- [x] 已核对\n- [ ] 待补充\n\n~~旧版本~~'} />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['来源', '日期'])
    expect(within(table).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['官方公告', '09-16'])
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes.map(input => input.checked)).toEqual([true, false])
    expect(checkboxes.every(input => input.disabled)).toBe(true)
    expect(container.querySelector('del')?.textContent).toBe('旧版本')
  })

  it('shows a fenced language and copies the rendered code text exactly', async () => {
    const code = 'const item = "<b>literal</b>";\nconsole.log(item);\n'
    const { container } = render(<MarkdownMessage text={'```typescript\n' + code + '```'} />)
    const pre = screen.getByLabelText('typescript代码块')
    expect(pre.tagName).toBe('PRE')
    expect(pre.querySelector('code')?.textContent).toBe(code)
    expect(pre.querySelector('b')).toBeNull()
    expect(container.querySelector('.markdown-code-toolbar')?.textContent).toContain('typescript')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code))
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('shows clipboard failures and allows a successful retry', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    render(<MarkdownMessage text={'```sh\necho hello\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '复制失败，可选中代码手动复制。')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await screen.findByText('已复制')
    expect(screen.queryByText('复制失败，可选中代码手动复制。')).toBeNull()
  })

  it('offers manual copying when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    render(<MarkdownMessage text={'```sh\necho hello\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '复制失败，可选中代码手动复制。')
    expect(screen.getByLabelText('sh代码块').textContent).toBe('echo hello\n')
  })

  it('updates an unfinished fence in place and copies only the latest streamed content', async () => {
    const view = render(<MarkdownMessage text={'## 实现\n\n```ts\nconst value ='} />)
    const initialPre = screen.getByLabelText('ts代码块')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await screen.findByText('已复制')
    view.rerender(<MarkdownMessage text={'## 实现\n\n```ts\nconst value = 42;\nconsole.log(value);\n```\n\n完成。'} />)
    expect(screen.getByLabelText('ts代码块')).toBe(initialPre)
    expect(view.container.querySelectorAll('pre')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(1)
    expect(screen.queryByText('已复制')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('const value = 42;\nconsole.log(value);\n'))
    expect(screen.getByText('完成。')).toBeTruthy()
  })
})

describe('MarkdownMessage link and media boundaries', () => {
  it('opens an HTTP link through the native bridge and exposes a recoverable failure', async () => {
    bridge.openExternalUrl.mockRejectedValueOnce(new Error('open failed'))
    render(<MarkdownMessage text={'[官方来源](https://example.com/news?q=agents "阅读原文")'} />)
    const link = screen.getByRole('link', { name: '官方来源' })
    expect(link.getAttribute('href')).toBe('https://example.com/news?q=agents')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    fireEvent.click(link)
    await waitFor(() => expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://example.com/news?q=agents'))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '链接未能打开，请重试。')
    fireEvent.click(link)
    await waitFor(() => expect(bridge.openExternalUrl).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('链接未能打开，请重试。')).toBeNull()
  })

  it.each([
    ['javascript', 'javascript:alert%281%29'],
    ['data', 'data:text/html;base64,PHNjcmlwdD4='],
    ['file', 'file:///Users/local/private.txt'],
    ['relative', './local-file.md'],
    ['absolute', '/Users/local/private.txt'],
    ['protocol-relative', '//example.com/asset'],
    ['credentials', 'https://user:pass@example.com/private'],
  ])('renders %s URLs as inert text', (_name, url) => {
    render(<MarkdownMessage text={`[不可执行链接](${url})`} />)
    expect(screen.getByText('不可执行链接')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByText('不可执行链接'))
    expect(bridge.openExternalUrl).not.toHaveBeenCalled()
  })

  it('keeps raw HTML inert and never inserts executable or resource-loading HTML elements', () => {
    const markup = '<script>window.__markdownExecuted = true</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n<iframe src="https://example.com/embed"></iframe>\n\n<a href="javascript:alert(1)">raw link</a>'
    const { container } = render(<MarkdownMessage text={markup} />)
    expect(container.querySelector('script, img, iframe, object, embed')).toBeNull()
    expect(container.querySelector('[onerror], [onclick]')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('<script>')
    expect((window as unknown as Record<string, unknown>).__markdownExecuted).toBeUndefined()
    expect(bridge.openExternalUrl).not.toHaveBeenCalled()
  })

  it('represents images as explicit links without creating image requests', async () => {
    const { container } = render(<MarkdownMessage text={'![架构图](https://example.com/diagram.png)\n\n![本地图片](file:///private/local.png)'} />)
    expect(container.querySelector('img, picture, source')).toBeNull()
    expect(bridge.openExternalUrl).not.toHaveBeenCalled()
    expect(screen.getByText('图片：本地图片').tagName).toBe('SPAN')
    fireEvent.click(screen.getByRole('link', { name: '图片：架构图' }))
    await waitFor(() => expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://example.com/diagram.png'))
  })

  it('isolates footnote IDs and fragment navigation between messages', () => {
    const text = '正文引用[^source]。\n\n[^source]: 本条消息的来源。'
    const { container } = render(<><MarkdownMessage text={text} /><MarkdownMessage text={text} /></>)
    const bodies = [...container.querySelectorAll('.markdown-body')]
    const allIds = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(allIds).size).toBe(allIds.length)
    for (const body of bodies) {
      const ref = body.querySelector('a[data-footnote-ref]') as HTMLAnchorElement
      const footnoteId = decodeURIComponent(ref.getAttribute('href')!.slice(1))
      const target = [...body.querySelectorAll('[id]')].find(element => element.id === footnoteId)
      expect(target).toBeTruthy()
      const descriptionId = ref.getAttribute('aria-describedby')
      expect(descriptionId).toBeTruthy()
      expect([...body.querySelectorAll('[id]')].some(element => element.id === descriptionId)).toBe(true)
      fireEvent.click(ref)
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', behavior: 'instant' })
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(target)
      expect(bridge.openExternalUrl).not.toHaveBeenCalled()
      const back = body.querySelector('a[data-footnote-backref]') as HTMLAnchorElement
      const backId = decodeURIComponent(back.getAttribute('href')!.slice(1))
      expect([...body.querySelectorAll('[id]')].some(element => element.id === backId)).toBe(true)
    }
  })
})

it('routes explicit, reference, bare and inline code links to artifacts without system navigation', () => {
  const onOpenLink = vi.fn()
  const text = '[远程](https://example.com/report)\n\n`/workspace/品质 报告.html`\n\n本地：./report.md\n\n[相对](./docs/guide.md)\n\n[文件](file:///workspace/report.html)\n\n[引用][source]\n\n[source]: https://example.com/source\n\n`https://example.com/inline`'
  const { container } = render(<MarkdownMessage text={text} onOpenLink={onOpenLink}/>)
  const links = screen.getAllByRole('link')
  expect(links).toHaveLength(7)
  for (const link of links) fireEvent.click(link)
  expect(onOpenLink.mock.calls.flat()).toEqual(['https://example.com/report', '/workspace/品质 报告.html', 'report.md', 'docs/guide.md', '/workspace/report.html', 'https://example.com/source', 'https://example.com/inline'])
  expect(container.querySelector('a > code')?.textContent).toBe('/workspace/品质 报告.html')
  expect(bridge.openExternalUrl).not.toHaveBeenCalled()
})

it('keeps fenced paths and executable URLs inert even with artifact navigation enabled', () => {
  const onOpenLink = vi.fn()
  const { container } = render(<MarkdownMessage text={'```sh\ncat /workspace/report.md\n```\n\n`html.parser` `console.log`\n\n[危险](javascript:alert%281%29) [协议](//example.com/file.md) [远程文件](file://server/etc/passwd) [凭证](https://user:pass@example.com)'} onOpenLink={onOpenLink}/>)
  expect(container.querySelectorAll('a')).toHaveLength(0)
  expect(screen.getByLabelText('sh代码块').textContent).toBe('cat /workspace/report.md\n')
})

it('keeps screenshot filenames as text while preserving intentional filename links', () => {
  const onOpenLink = vi.fn()
  const filename = 'EC02548A-60C6-41C1-B883-4BE94F15C7AF.PNG'
  const { container } = render(<MarkdownMessage text={`截图中的文件名 \`${filename}\`。正文提到 photo.png 和 report.md。\n\n[打开报告](report.md)\n\n明确路径：./photo.png`} onOpenLink={onOpenLink}/>)
  const code = container.querySelector('code')!
  expect(code.textContent).toBe(filename)
  expect(code.closest('a')).toBeNull()
  fireEvent.click(code)
  expect(onOpenLink).not.toHaveBeenCalled()
  const links = screen.getAllByRole('link')
  expect(links).toHaveLength(2)
  for (const link of links) fireEvent.click(link)
  expect(onOpenLink.mock.calls.flat()).toEqual(['report.md', 'photo.png'])
})
