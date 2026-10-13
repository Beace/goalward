import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Blockquote, Root } from 'mdast'
import { remarkGithubAlerts } from './markdown-alerts'

const parser = unified().use(remarkParse).use(remarkGfm)
const renderer = unified().use(remarkParse).use(remarkGfm).use(remarkGithubAlerts)

function render(text: string): Root {
  return renderer.runSync(renderer.parse(text), text) as Root
}

function quote(text: string): Blockquote {
  const node = render(text).children[0]
  if (node.type !== 'blockquote') throw new Error('Expected a blockquote')
  return node
}

describe('GitHub Markdown alerts', () => {
  it.each([
    ['NOTE', 'Note'], ['TIP', 'Tip'], ['IMPORTANT', 'Important'], ['WARNING', 'Warning'], ['CAUTION', 'Caution'],
  ])('renders the %s marker as a title and typed blockquote', (type, title) => {
    const alert = quote(`> [!${type}]\n> Information.`)
    expect(alert.data?.hProperties).toEqual({ 'data-markdown-alert': type.toLowerCase() })
    expect(alert.children).toMatchObject([
      { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: title }] }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Information.' }] },
    ])
  })

  it('retains inline formatting, subsequent paragraphs, links and lists', () => {
    const alert = quote('> [!WARNING]\n> **Unsigned** build with `code` and [details](https://example.com).\n>\n> Second paragraph.\n>\n> - One\n> - Two')
    expect(alert.children).toMatchObject([
      { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: 'Warning' }] }] },
      { type: 'paragraph', children: [
        { type: 'strong', children: [{ type: 'text', value: 'Unsigned' }] },
        { type: 'text', value: ' build with ' }, { type: 'inlineCode', value: 'code' },
        { type: 'text', value: ' and ' }, { type: 'link', url: 'https://example.com' }, { type: 'text', value: '.' },
      ] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Second paragraph.' }] },
      { type: 'list', children: [{ type: 'listItem' }, { type: 'listItem' }] },
    ])
  })

  it.each(['> [!WARNING]\n>\n> Body.', '> [!WARNING]  \n> Body.', '> [!WARNING]\r\n> Body.'])('handles paragraph and line-break boundaries: %j', text => {
    expect(quote(text).children).toMatchObject([
      { type: 'paragraph', children: [{ type: 'strong' }] },
      { type: 'paragraph', children: [{ type: 'text', value: 'Body.' }] },
    ])
  })

  it.each([
    '> [!UNKNOWN]\n> Body.',
    '> [!warning]\n> Body.',
    '> [!WARNING] same-line body.',
    '> [!WARNING] **same-line body**',
    '> Before [!WARNING]\n> Body.',
    '> First paragraph.\n>\n> [!WARNING]\n> Body.',
    '> `[!WARNING]`\n> Body.',
    '> **[!WARNING]**\n> Body.',
    '> \\[!WARNING]\n> Body.',
    '> &#91;!WARNING]\n> Body.',
    '> ```text\n> [!WARNING]\n> ```',
    '[!WARNING]\n\nOrdinary text.',
    '- Item\n\n  > [!WARNING]\n  > Nested alert.',
    '> Outer quote.\n>\n> > [!WARNING]\n> > Nested alert.',
  ])('keeps ordinary, escaped, code and nested markers unchanged: %j', text => {
    expect(render(text)).toEqual(parser.parse(text))
  })

  it('preserves a nested quote inside an alert without interpreting its marker', () => {
    const alert = quote('> [!WARNING]\n> Outer alert.\n>\n> > [!NOTE]\n> > Nested quote.')
    const nested = alert.children[2]
    expect(nested).toMatchObject({ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!NOTE]\nNested quote.' }] }] })
    expect(nested.data?.hProperties).toBeUndefined()
  })

  it('preserves existing blockquote metadata and remains stable on repeat parsing', () => {
    const text = '> [!TIP]\n> Body.'
    const tree = renderer.parse(text)
    const node = tree.children[0]
    const metadata = { custom: 'retained', hProperties: { className: ['custom-quote'] } }
    node.data = metadata
    const alert = renderer.runSync(tree, text) as Root
    expect(alert.children[0].data).toEqual({ custom: 'retained', hProperties: { className: ['custom-quote'], 'data-markdown-alert': 'tip' } })
    const before = structuredClone(alert)
    expect(renderer.runSync(alert, text)).toEqual(before)
  })
})
