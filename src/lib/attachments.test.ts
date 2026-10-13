// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { MAX_CLIPBOARD_BYTES, promptWithAttachments, readClipboardAttachments, splitAttachmentMessage, isImageAttachment } from './attachments'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, isTauri: () => mock.desktop }))
vi.mock('./bridge', () => ({ get isDesktop() { return mock.desktop } }))
beforeEach(() => { mock.desktop = true; mock.invoke.mockReset() })

it('projects persisted image attachments into UI while keeping the original prompt intact', () => {
  const files = [{ name: 'screenshot "café".png', path: '/Users/test/Library/Application Support/attachments/screenshot "café".png' }, { name: 'readme.pdf', path: '/tmp/readme.pdf' }]
  const original = promptWithAttachments('What is in the image?\nSecond line of text', files)
  expect(splitAttachmentMessage(original)).toEqual({ text: 'What is in the image?\nSecond line of text', attachments: files })
  expect(splitAttachmentMessage(promptWithAttachments('', files))).toEqual({ text: '', attachments: files })
  expect(isImageAttachment(files[0])).toBe(true)
  expect(isImageAttachment(files[1])).toBe(false)
  expect(isImageAttachment({ name: 'photo', path: '/tmp/PHOTO.HEIC' })).toBe(true)
})
it.each([
  'Plain text /tmp/image.png',
  '附件（本地文件路径）：\n- "x.png": "https://example.com/x.png"',
  '附件（本地文件路径）：\n- "x.png": "/tmp/x.png"\nSubsequent body text must remain visible',
  '附件（本地文件路径）：\n- Invalid content',
  'Quoted 附件（本地文件路径）：\n- "x.png": "/tmp/x.png"',
])('preserves ordinary or malformed text without automatically loading arbitrary URLs: %s', text => {
  expect(splitAttachmentMessage(text)).toEqual({ text, attachments: [] })
})

it('preserves ordinary prompts and quotes special filename/path characters without shell expansion', () => {
  expect(promptWithAttachments(' text ', [])).toBe('text')
  const path = '/tmp/"name"\n$(touch innocent).png'
  expect(promptWithAttachments('', [{ name: 'name', path }])).toContain(JSON.stringify(path))
})
it('prefers native file paths to WebKit copies', async () => {
  const native = [{ name: 'file.pdf', path: '/tmp/file.pdf' }]
  mock.invoke.mockResolvedValueOnce(native)
  expect(await readClipboardAttachments([new File(['bytes'], 'file.pdf')])).toEqual(native)
  expect(mock.invoke).toHaveBeenCalledTimes(1)
})
it('persists WebKit file bytes through Rust when no native file is available', async () => {
  mock.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce({ name: 'image.png', path: '/saved/image.png' })
  const saved = await readClipboardAttachments([new File(['hello'], 'image.png', { type: 'image/png' })])
  expect(mock.invoke).toHaveBeenLastCalledWith('save_clipboard_file', { name: 'image.png', data: 'aGVsbG8=' })
  expect(saved[0].path).toBe('/saved/image.png')
})
it('rejects oversized clipboard blobs before encoding and never fabricates browser paths', async () => {
  mock.invoke.mockResolvedValueOnce([])
  const file = new File(['small'], 'large.bin')
  Object.defineProperty(file, 'size', { value: MAX_CLIPBOARD_BYTES + 1 })
  await expect(readClipboardAttachments([file])).rejects.toThrow('32 MB')
  expect(mock.invoke).toHaveBeenCalledTimes(1)
  mock.desktop = false
  await expect(readClipboardAttachments([file])).rejects.toThrow('浏览器预览')
})
