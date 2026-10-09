// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentImage } from './AttachmentImage'
import { ComposerAttachments } from './ComposerAttachments'
import { UserMessage } from './UserMessage'
import { promptWithAttachments } from '@/lib/attachments'

const mock = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/attachments', async original => ({ ...await original<typeof import('@/lib/attachments')>(), readAttachmentImage: mock.read }))
const file = { name: '截图.png', path: '/Users/test/Library/Application Support/attachments/截图.png' }
const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
beforeEach(() => {
  mock.read.mockReset().mockResolvedValue(source)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(cleanup)

it('shows the actual image in the composer and opens it without exposing the path in the visible UI', async () => {
  const remove = vi.fn()
  render(<ComposerAttachments attachments={[{ ...file, id: 'image' }]} importing={false} onRemove={remove} />)
  const image = await screen.findByRole('img', { name: file.name })
  expect(image.getAttribute('src')).toBe(source)
  expect(document.querySelector('.attachment-image-caption')).toBeNull()
  fireEvent.load(image)
  expect(document.body.textContent).not.toContain(file.name)
  const trigger = screen.getByRole('button', { name: `预览图片 ${file.name}` })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe(source)
  expect(document.body.textContent).not.toContain(file.path)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  fireEvent.click(screen.getByRole('button', { name: `移除附件 ${file.name}` }))
  expect(remove).toHaveBeenCalledWith('image')
})

it('renders legacy sent messages as text plus images, leaving the serialized model prompt unchanged', async () => {
  const original = promptWithAttachments('图片里有什么', [file, { name: '文档.pdf', path: '/tmp/文档.pdf' }])
  render(<UserMessage text={original} />)
  expect(screen.getByText('图片里有什么')).toBeTruthy()
  expect(screen.getByText('文档.pdf')).toBeTruthy()
  const image = await screen.findByRole('img', { name: file.name })
  expect(document.querySelector('.attachment-image-caption')).toBeNull()
  fireEvent.load(image)
  expect(document.body.textContent).not.toContain(file.name)
  expect(document.body.textContent).not.toContain('附件（本地文件路径）')
  expect(document.body.textContent).not.toContain(file.path)
  expect(original).toContain(file.path)
})

it('offers a retry on read/decode failure and ignores stale responses after a path change', async () => {
  mock.read.mockRejectedValueOnce(new Error('图片已被移动'))
  const view = render(<AttachmentImage file={file} />)
  await screen.findByText('图片无法预览')
  expect(screen.getByRole('button', { name: `重新加载图片 ${file.name}` }).getAttribute('title')).toBe('图片已被移动')
  fireEvent.click(screen.getByRole('button', { name: `重新加载图片 ${file.name}` }))
  const image = await screen.findByRole('img')
  fireEvent.error(image)
  await screen.findByText('图片无法预览')
  let resolve!: (src: string) => void
  mock.read.mockImplementationOnce(() => new Promise<string>(done => { resolve = done }))
  fireEvent.click(screen.getByRole('button', { name: `重新加载图片 ${file.name}` }))
  const other = { name: '另一张.png', path: '/tmp/另一张.png' }
  view.rerender(<AttachmentImage file={other} />)
  await screen.findByRole('img', { name: other.name })
  await act(async () => resolve('data:image/png;base64,STALE'))
  expect(screen.getByRole('img').getAttribute('src')).toBe(source)
})
