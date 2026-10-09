// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Workbench } from './Workbench'
import { createInitialState, createTask } from '@/lib/domain'
import type { AttachmentFile } from '@/lib/attachments'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/bridge', async original => ({ ...await original<typeof import('@/lib/bridge')>(), isDesktop: true }))
vi.mock('@/lib/attachments', async original => ({ ...await original<typeof import('@/lib/attachments')>(), readClipboardAttachments: mocks.read }))
const first = { name: '报告 中文.pdf', path: '/tmp/中文 project/报告 中文.pdf' }
const second = { name: '截图.png', path: '/tmp/attachments/unique/截图.png' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue([first])
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})
afterEach(cleanup)

function mount(onSend = vi.fn(async (_prompt: string, _recipient: string) => {})) {
  const { settings } = createInitialState()
  const task = createTask(settings, '附件测试', '/tmp', 'solo')
  const view = render(<Workbench task={task} settings={settings} selectedRunId="" onChange={vi.fn()} onSelectRun={vi.fn()} onSend={onSend} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
  return { ...view, onSend, input: screen.getByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement }
}
function paste(input: HTMLTextAreaElement, text = '', files: File[] = []) {
  fireEvent.paste(input, { clipboardData: { files, getData: () => text } })
}

it('deduplicates Finder files, displays names and sends only real paths, including attachment-only messages', async () => {
  mocks.read.mockResolvedValue([first, second])
  const { input, onSend } = mount()
  paste(input)
  await screen.findByText(first.name)
  paste(input)
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
  expect(onSend.mock.calls[0][0]).toBe('附件（本地文件路径）：\n- "报告 中文.pdf": "/tmp/中文 project/报告 中文.pdf"\n- "截图.png": "/tmp/attachments/unique/截图.png"')
  await waitFor(() => expect(screen.queryByLabelText('待发送附件')).toBeNull())
})

it('blocks sending during import, keeps failed submissions and only removes the successfully submitted snapshot', async () => {
  let imported!: (files: AttachmentFile[]) => void
  mocks.read.mockReturnValueOnce(new Promise<AttachmentFile[]>(resolve => { imported = resolve }))
  let finish!: () => void
  const onSend = vi.fn<(prompt: string, recipient: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('启动失败'))
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const { input } = mount(onSend)
  fireEvent.change(input, { target: { value: '请查看' } })
  paste(input)
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(onSend).not.toHaveBeenCalled()
  await act(async () => imported([first]))
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }))
  await screen.findByText('启动失败')
  expect(screen.getByText(first.name)).toBeTruthy()
  expect(input.value).toBe('请查看')
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }))
  mocks.read.mockResolvedValueOnce([second])
  paste(input)
  await screen.findByRole('button', { name: `移除附件 ${second.name}` })
  fireEvent.change(input, { target: { value: '下一轮草稿' } })
  await act(async () => finish())
  expect(screen.queryByText(first.name)).toBeNull()
  expect(screen.queryByRole('button', { name: `移除附件 ${first.name}` })).toBeNull()
  expect(screen.getByRole('button', { name: `移除附件 ${second.name}` })).toBeTruthy()
  expect(input.value).toBe('下一轮草稿')
})

it('removes attachments with focus restored, and surfaces import errors without losing text', async () => {
  const { input } = mount()
  paste(input)
  fireEvent.click(await screen.findByRole('button', { name: `移除附件 ${first.name}` }))
  expect(document.activeElement).toBe(input)
  expect(screen.queryByLabelText('待发送附件')).toBeNull()
  mocks.read.mockRejectedValueOnce(new Error('文件已经移动'))
  fireEvent.change(input, { target: { value: '原草稿' } })
  paste(input)
  await screen.findByText('文件已经移动')
  expect(input.value).toBe('原草稿')
})

it('inserts ordinary desktop text at the selection and does not create an attachment', async () => {
  mocks.read.mockResolvedValueOnce([])
  const { input } = mount()
  fireEvent.change(input, { target: { value: 'before SELECT after' } })
  input.setSelectionRange(7, 13)
  paste(input, '粘贴文字')
  await waitFor(() => expect(input.value).toBe('before 粘贴文字 after'))
  expect(screen.queryByLabelText('待发送附件')).toBeNull()
})

it('does not transfer an in-flight paste to a different task after unmount', async () => {
  let imported!: (files: AttachmentFile[]) => void
  mocks.read.mockReturnValueOnce(new Promise<AttachmentFile[]>(resolve => { imported = resolve }))
  const old = mount()
  paste(old.input)
  old.unmount()
  mount()
  await act(async () => imported([first]))
  expect(screen.queryByLabelText('待发送附件')).toBeNull()
})
