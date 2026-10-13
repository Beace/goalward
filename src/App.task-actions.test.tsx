// @vitest-environment jsdom
import { hasSemanticText } from '@/test/semantic-text'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import { createWorkspaceTask } from './lib/workspace'
import type { AppState, Task } from './lib/types'

const bridge = vi.hoisted(() => ({ isDesktop: true, activeRuntimeTurns: vi.fn(async () => []), loadState: vi.fn(), saveState: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/Workbench', () => ({ Workbench: ({ task, taskActions, operations, onSend }: { task: Task; taskActions: ReactNode; operations: ReactNode; onSend: (prompt: string, recipient: string) => Promise<void> }) => <section aria-label="Test workbench"><h1 data-task-heading tabIndex={-1}>{task.title}</h1>{taskActions}<button onClick={() => void onSend('Test instruction', 'all').catch(() => {})}>Test startup</button>{operations}</section> }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))

let stored: AppState
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  stored = createInitialState()
  stored.tasks = [createWorkspaceTask(stored.settings, { title: 'Organize task documentation', directory: '/tmp', acceptance: 'Provide verification records' }), createWorkspaceTask(stored.settings, { title: 'Verify implementation' })]
  stored.activeTaskId = stored.tasks[0].id
  stored.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (value: AppState) => { stored = structuredClone(value) })
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.onRuntimeEvent.mockResolvedValue(() => {})
  bridge.startRun.mockResolvedValue(undefined)
  bridge.stopRun.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function mountTasks() {
  render(<App />)
  const nav = await screen.findByRole('navigation', { name: '工作空间导航' })
  fireEvent.click(within(nav).getByRole('button', { name: /^任务\s*\d+$/ }))
  return screen.findByRole('heading', { name: '任务', level: 1 })
}
async function openEdit(title = 'Organize task documentation') {
  fireEvent.click(screen.getByRole('button', { name: `编辑任务：${title}` }))
  return screen.findByRole('dialog', { name: '编辑任务' })
}
async function openDelete(title = 'Organize task documentation') {
  fireEvent.click(screen.getByRole('button', { name: `删除任务：${title}` }))
  return screen.findByRole('dialog', { name: '删除任务？' })
}
async function closed() { await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()) }

describe('task editing and deletion through the application', () => {
  it('edits the selected task while keeping its sidebar and workbench visible', async () => {
    await mountTasks()
    const opener = screen.getByRole('button', { name: '打开任务：Organize task documentation' })
    expect(opener.querySelector('button')).toBeNull()
    let dialog = await openEdit()
    const initialInput = within(dialog).getByRole('textbox', { name: '编辑任务名称' }) as HTMLInputElement
    expect(document.activeElement).toBe(initialInput)
    fireEvent.change(initialInput, { target: { value: 'Cancelled draft' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await closed()
    expect(stored.tasks[0].title).toBe('Organize task documentation')
    dialog = await openEdit()
    expect((within(dialog).getByRole('textbox', { name: '编辑任务名称' }) as HTMLInputElement).value).toBe('Organize task documentation')
    fireEvent.change(within(dialog).getByRole('textbox', { name: '编辑任务名称' }), { target: { value: ' Organized task description ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '编辑验收要求' }), { target: { value: 'Documentation matches the interface' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存任务' }))
    await closed()
    expect(stored.tasks[0]).toMatchObject({ title: 'Organized task description', acceptance: 'Documentation matches the interface' })
    expect(screen.getByRole('button', { name: '打开任务：Organized task description' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Test workbench' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '任务', level: 1 })).toBeTruthy()
  })

  it('restores an unsaved title but keeps the edit draft and allows a successful retry', async () => {
    await mountTasks()
    const dialog = await openEdit()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '编辑任务名称' }), { target: { value: 'Draft after failed save' } })
    let failed = false
    bridge.saveState.mockImplementation(async (value: AppState) => {
      if (!failed && value.tasks[0].title === 'Draft after failed save') { failed = true; throw new Error('edit disk unavailable') }
      stored = structuredClone(value)
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('edit disk unavailable'))
    expect(stored.tasks[0].title).toBe('Organize task documentation')
    expect((within(dialog).getByRole('textbox', { name: '编辑任务名称' }) as HTMLInputElement).value).toBe('Draft after failed save')
    expect(document.querySelector('.task-picker-item')?.getAttribute('aria-label')).toBe('打开任务：Organize task documentation')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存任务' }))
    await closed()
    expect(stored.tasks[0].title).toBe('Draft after failed save')
  })

  it('blocks application navigation shortcuts inside a task dialog while Escape still closes and restores focus', async () => {
    await mountTasks()
    const trigger = screen.getByRole('button', { name: '编辑任务：Organize task documentation' })
    const dialog = await openEdit()
    const input = within(dialog).getByRole('textbox', { name: '编辑任务名称' })
    for (const modifier of ['metaKey', 'ctrlKey']) {
      for (const key of ['k', 'n', ',']) {
        const event = new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true })
        act(() => { input.dispatchEvent(event) })
        expect(event.defaultPrevented).toBe(true)
        expect(screen.getAllByRole('dialog')).toEqual([dialog])
        expect(document.querySelector('[data-task-list-heading]')?.textContent).toBe('任务')
      }
    }
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })
    await closed()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(screen.getByRole('heading', { name: '任务', level: 1 })).toBeTruthy()
  })

  it('focuses cancel in the delete confirmation and cancellation retains all data and restores focus', async () => {
    await mountTasks()
    const before = structuredClone(stored)
    const trigger = screen.getByRole('button', { name: '删除任务：Organize task documentation' })
    const dialog = await openDelete()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }))
    expect(within(dialog).getByText('Organize task documentation')).toBeTruthy()
    expect(within(dialog).getByText(hasSemanticText('0 条对话 · 0 次执行 · 0 项结果'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await closed()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(stored).toEqual(before)
  })

  it('deletes the current task and shows a remaining task beside the list', async () => {
    await mountTasks()
    const deletedId = stored.tasks[0].id, remainingId = stored.tasks[1].id
    fireEvent.click(screen.getByRole('button', { name: '打开任务：Organize task documentation' }))
    await screen.findByRole('region', { name: 'Test workbench' })
    const dialog = await openDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }))
    await closed()
    expect(stored.tasks.some(task => task.id === deletedId)).toBe(false)
    expect(stored.activeTaskId).toBe(remainingId)
    const heading = screen.getByRole('heading', { name: '任务', level: 1 })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByRole('button', { name: '打开任务：Verify implementation' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Test workbench' })).toBeTruthy()
    expect(screen.getByText('任务已删除')).toBeTruthy()
  })

  it('handles deleting the final task with an empty list and creation entry', async () => {
    stored.tasks = [stored.tasks[0]]
    await mountTasks()
    const dialog = await openDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }))
    await closed()
    expect(stored.tasks).toEqual([])
    expect(stored.activeTaskId).toBe('')
    expect(screen.getByRole('heading', { name: '还没有任务' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建任务' })).toBeTruthy()
  })

  it('restores the deleted task and active selection after a disk failure and keeps confirmation retryable', async () => {
    await mountTasks()
    const deletedId = stored.tasks[0].id
    fireEvent.click(screen.getByRole('button', { name: '打开任务：Organize task documentation' }))
    await screen.findByRole('region', { name: 'Test workbench' })
    const dialog = await openDelete()
    let failed = false
    bridge.saveState.mockImplementation(async (value: AppState) => {
      if (!failed && !value.tasks.some(task => task.id === deletedId)) { failed = true; throw new Error('delete disk unavailable') }
      stored = structuredClone(value)
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('delete disk unavailable'))
    expect(stored.tasks[0].id).toBe(deletedId)
    expect(stored.activeTaskId).toBe(deletedId)
    expect(document.querySelector('[data-task-heading]')?.textContent).toBe('Organize task documentation')
    expect(screen.queryByText('任务已删除')).toBeNull()
    expect((within(dialog).getByRole('button', { name: '删除任务' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }))
    await closed()
    expect(stored.tasks.some(task => task.id === deletedId)).toBe(false)
    expect(screen.getByRole('heading', { name: '任务', level: 1 })).toBeTruthy()
  })

  it('blocks deletion for children and dependencies and offers a direct related-task entry', async () => {
    const parent = stored.tasks[0]
    stored.tasks[1].dependencies = [parent.id]
    stored.tasks.push(createWorkspaceTask(stored.settings, { title: 'Child task verification', parentTaskId: parent.id }))
    await mountTasks()
    const dialog = await openDelete()
    expect(within(dialog).getByText(hasSemanticText('请先处理 1 个子任务'))).toBeTruthy()
    expect(within(dialog).getByText(hasSemanticText('1 个任务仍依赖此任务'))).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: '删除任务' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify implementation' }))
    await closed()
    expect(screen.getByRole('heading', { name: 'Verify implementation' })).toBeTruthy()
    expect(stored.tasks).toHaveLength(3)
  })

  it('disables explicit list edit and delete actions while the task is actually executing', async () => {
    await mountTasks()
    fireEvent.click(screen.getByRole('button', { name: '打开任务：Organize task documentation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Test startup' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    fireEvent.click(within(screen.getByRole('navigation', { name: '工作空间导航' })).getByRole('button', { name: /^任务\s*\d+$/ }))
    expect((screen.getByRole('button', { name: '编辑任务：Organize task documentation' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '删除任务：Organize task documentation' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText('请先停止执行和编排，再编辑或删除').length).toBeGreaterThan(0)
  })

  it('does not report deletion success or repeat the mutation before persistence resolves', async () => {
    await mountTasks()
    const dialog = await openDelete()
    const targetId = stored.tasks[0].id
    let release: (() => void) | undefined
    bridge.saveState.mockImplementation(async (value: AppState) => {
      if (!value.tasks.some(task => task.id === targetId)) await new Promise<void>(resolve => { release = resolve })
      stored = structuredClone(value)
    })
    const previousCalls = bridge.saveState.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }))
    expect((await within(dialog).findByRole('button', { name: '删除中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(dialog).getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(dialog.querySelector('form')!)
    expect(screen.queryByText('任务已删除')).toBeNull()
    expect(bridge.saveState.mock.calls.length).toBe(previousCalls + 1)
    expect(stored.tasks.some(task => task.id === targetId)).toBe(true)
    await act(async () => release?.())
    await closed()
    expect(stored.tasks.some(task => task.id === targetId)).toBe(false)
  })
})
