// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceMentionInput } from './WorkspaceMentionInput'
import type { WorkspaceSearchResult } from '@/lib/workspace-references'

const entries = [{ name: '中文 space.md', path: '/project/中文 space.md', relativePath: '中文 space.md', root: '/project', kind: 'file' as const }, { name: 'docs', path: '/second/docs', relativePath: 'docs', root: '/second', kind: 'folder' as const }]
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mount(search = vi.fn(async (_directories: string[], _query: string): Promise<WorkspaceSearchResult> => ({ entries, truncated: false })), onKeyDown = vi.fn()) {
  function Harness() { const [value, setValue] = useState(''); return <WorkspaceMentionInput aria-label="message" value={value} onValueChange={setValue} directories={['/project', '/second']} search={search} onKeyDown={onKeyDown} /> }
  return { ...render(<Harness />), search, onKeyDown, input: screen.getByRole('textbox', { name: 'message' }) as HTMLTextAreaElement }
}
it('keeps focus, handles keyboard folder selection and passes ordinary send shortcuts to the composer', async () => {
  const { input, search, onKeyDown } = mount()
  fireEvent.change(input, { target: { value: '查看 @', selectionStart: 4 } })
  await screen.findByText('中文 space.md')
  expect(search).toHaveBeenCalledWith(['/project', '/second'], '')
  input.focus()
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(input.value).toBe('查看 @"/second/docs" ')
  expect(document.activeElement).toBe(input)
  expect(screen.queryByLabelText('引用文件或文件夹')).toBeNull()
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(onKeyDown).toHaveBeenCalledOnce()
})
it('ignores late search replies and retains the draft on filesystem errors', async () => {
  let first!: (result: WorkspaceSearchResult) => void
  const search = vi.fn<(directories: string[], query: string) => Promise<WorkspaceSearchResult>>()
    .mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
    .mockResolvedValueOnce({ entries: [entries[1]], truncated: true })
    .mockRejectedValueOnce(new Error('目录不可读取'))
  const { input } = mount(search)
  fireEvent.change(input, { target: { value: '@a', selectionStart: 2 } })
  fireEvent.change(input, { target: { value: '@ab', selectionStart: 3 } })
  await screen.findByText('docs')
  await act(async () => first({ entries: [entries[0]], truncated: false }))
  expect(screen.queryByText('中文 space.md')).toBeNull()
  expect(screen.getByText('仅显示部分结果，继续输入文件名或路径。')).toBeTruthy()
  fireEvent.change(input, { target: { value: '@abc', selectionStart: 4 } })
  await screen.findByText('目录不可读取')
  expect(input.value).toBe('@abc')
})
it('supports pointer selection, Escape and IME without consuming composition Enter', async () => {
  const { input, onKeyDown } = mount()
  fireEvent.change(input, { target: { value: '@', selectionStart: 1 } })
  const option = await screen.findByText('中文 space.md')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(input.value).toBe('@')
  expect(onKeyDown).toHaveBeenCalledOnce()
  fireEvent.click(option)
  expect(input.value).toBe(`@${JSON.stringify(entries[0].path)} `)
  fireEvent.change(input, { target: { value: '@d', selectionStart: 2 } })
  await waitFor(() => expect(screen.getByText('docs')).toBeTruthy())
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByLabelText('引用文件或文件夹')).toBeNull()
  expect(input.value).toBe('@d')
})
