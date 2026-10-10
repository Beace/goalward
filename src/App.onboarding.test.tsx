// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { AppState, LocalDiscoveryReport } from './lib/types'
import * as artifacts from './lib/artifacts'
import { createInitialState } from './lib/domain'

const bridge = vi.hoisted(() => ({
  isDesktop: true, loadState: vi.fn(), saveState: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(),
  discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(),
  startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(),
}))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/Workbench', () => ({ Workbench: ({ task }: { task: { title: string } }) => <h1>{task.title}</h1> }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => <aside>执行记录</aside> }))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <span />,
}))

let stored: AppState | null
let failSetupSave = false
const detected = (): LocalDiscoveryReport => ({ scannedAt: '2026-09-15T12:00:00Z', runtimes: [
  { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', probe: { found: true, path: '/local/bin/codex', version: '1.0' }, models: [{ modelId: 'configured-model', name: '配置模型', source: 'config.toml', selected: true }], configSources: ['/home/.codex/config.toml'], warnings: [] },
  { id: 'claude', name: 'Claude Code', executable: 'claude', adapter: 'claude', probe: { found: false, path: '', version: '' }, models: [], configSources: [], warnings: [] },
] })
beforeEach(() => {
  vi.resetAllMocks(); stored = null; failSetupSave = false
  bridge.loadState.mockImplementation(async () => stored && structuredClone(stored))
  bridge.saveState.mockImplementation(async (state: AppState) => {
    if (failSetupSave && state.onboarding) throw new Error('disk unavailable')
    stored = structuredClone(state)
  })
  bridge.onRuntimeEvent.mockResolvedValue(() => {})
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.discoverLocalEnvironment.mockImplementation(async () => detected())
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('desktop first launch lifecycle', () => {
  it('keeps the destination layout mounted while the first read is pending and fills it in place', async () => {
    let complete!: (state: AppState) => void
    bridge.loadState.mockImplementation(() => new Promise<AppState>(resolve => { complete = resolve }))
    render(<App />)
    const navigation = screen.getByRole('navigation', { name: '工作空间导航' })
    const list = screen.getByRole('complementary', { name: '目标列表' })
    expect(within(list).getByRole('status').textContent).toBe('正在读取目标…')
    expect((screen.getByLabelText('搜索目标') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByText('无运行中的进程')).toBeNull()
    expect(screen.queryByText('已保存到本地')).toBeNull()
    expect(document.querySelector('.app-loading')).toBeNull()
    const initial = { ...createInitialState(), onboarding: { version: 1 as const, completedAt: '2026-09-17T00:00:00Z', outcome: 'configured' as const } }
    await act(async () => complete(initial))
    await screen.findByRole('heading', { name: '开始一件事' })
    expect(screen.getByRole('navigation', { name: '工作空间导航' })).toBe(navigation)
    expect((screen.getByLabelText('搜索目标') as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByText('正在读取目标…')).toBeNull()
    expect(document.querySelector('.app-loading')).toBeNull()
  })

  it('keeps read failures inside the goal list without showing a false empty workspace', async () => {
    bridge.loadState.mockRejectedValue(new Error('database unavailable'))
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('database unavailable')
    expect(screen.getByRole('complementary', { name: '目标列表' }).contains(alert)).toBe(true)
    expect(screen.getByRole('navigation', { name: '工作空间导航' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '开始一件事' })).toBeNull()
    expect(document.querySelector('.app-loading')).toBeNull()
    expect(bridge.saveState).not.toHaveBeenCalled()
  })

  it('defers historical artifact parsing until the task workbench is opened', async () => {
    stored = { ...createInitialState(), onboarding: { version: 1, completedAt: '2026-09-17T00:00:00Z', outcome: 'configured' } }
    const index = vi.spyOn(artifacts, 'getTaskArtifacts')
    try {
      render(<App />)
      const task = await screen.findByRole('button', { name: /为工作台增加全局命令面板/ })
      expect(index).not.toHaveBeenCalled()
      bridge.saveState.mockClear()
      fireEvent.click(task)
      await screen.findByRole('heading', { name: '为工作台增加全局命令面板' })
      expect(index).toHaveBeenCalled()
      expect(bridge.saveState).not.toHaveBeenCalled()
    } finally { index.mockRestore() }
  })

  it('automatically scans once, persists import and skips onboarding after restart', async () => {
    const app = render(<StrictMode><App /></StrictMode>)
    await screen.findByRole('button', { name: /导入所选 1 项并继续/ })
    expect(bridge.discoverLocalEnvironment).toHaveBeenCalledTimes(1)
    expect(bridge.startRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /导入所选 1 项并继续/ }))
    await screen.findByRole('button', { name: /为工作台增加全局命令面板/ })
    expect(stored?.onboarding?.outcome).toBe('imported')
    expect(stored?.settings.models[0].modelId).toBe('configured-model')
    expect(stored?.settings.runtimes.find(runtime => runtime.id === 'claude')?.enabled).toBe(false)
    app.unmount()
    render(<App />)
    await screen.findByRole('button', { name: /为工作台增加全局命令面板/ })
    expect(bridge.discoverLocalEnvironment).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: '连接你的 Agent Runtime' })).toBeNull()
  })
  it('allows planning without installed runtimes and creates no placeholder execution member', async () => {
    bridge.discoverLocalEnvironment.mockResolvedValue({ scannedAt: '2026-09-15T12:00:00Z', runtimes: detected().runtimes.map(runtime => ({ ...runtime, probe: { found: false, path: '', version: '' }, models: [] })) })
    render(<App />)
    await screen.findByText('安装 Agent Runtime')
    fireEvent.click(screen.getByRole('button', { name: '稍后配置' }))
    await screen.findByText('目标和任务可先记录；启动 Agent 前请配置本地 Runtime。')
    expect(stored?.settings.runtimes.some(runtime => runtime.enabled)).toBe(false)
    fireEvent.click(within(screen.getByRole('navigation', { name: '工作空间导航' })).getByRole('button', { name: /^任务/ }))
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await screen.findByRole('dialog', { name: '新建任务' })
    fireEvent.change(screen.getByLabelText('任务目标'),{target:{value:'先记录探索问题'}})
    fireEvent.click(screen.getByRole('button',{name:'创建任务'}))
    await screen.findByRole('heading',{name:'先记录探索问题'})
    expect(stored?.tasks[0].members).toEqual([])
    expect(bridge.startRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: '手动配置' })[0])
    await screen.findByRole('region', { name: '首次配置指引' })
    expect(screen.getByLabelText('可执行文件')).toBeTruthy()
  })
  it('stays on discovery after a failed save, preserves choices and succeeds on retry', async () => {
    render(<App />)
    await screen.findByRole('button', { name: /导入所选 1 项并继续/ })
    failSetupSave = true
    fireEvent.click(screen.getByRole('button', { name: /导入所选 1 项并继续/ }))
    await screen.findByText(/配置未能保存/)
    expect(stored?.onboarding).toBeUndefined()
    expect(screen.getByRole('checkbox', { name: '导入 Codex' }).getAttribute('aria-checked')).toBe('true')
    failSetupSave = false
    await waitFor(() => expect((screen.getByRole('button', { name: /导入所选 1 项并继续/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /导入所选 1 项并继续/ }))
    await screen.findByRole('button', { name: /为工作台增加全局命令面板/ })
    expect(stored?.onboarding?.outcome).toBe('imported')
  })
  it('can import a runtime installed after the initial empty scan and deferred setup', async () => {
    bridge.discoverLocalEnvironment.mockResolvedValueOnce({ scannedAt: '2026-09-15T12:00:00Z', runtimes: detected().runtimes.map(runtime => ({ ...runtime, probe: { found: false, path: '', version: '' }, models: [] })) })
    render(<App />)
    await screen.findByText('安装 Agent Runtime')
    fireEvent.click(screen.getByRole('button', { name: '稍后配置' }))
    await screen.findByText('目标和任务可先记录；启动 Agent 前请配置本地 Runtime。')
    fireEvent.click(screen.getByRole('button', { name: '检测本机环境' }))
    await screen.findByRole('button', { name: /导入所选 1 项并继续/ })
    fireEvent.click(screen.getByRole('button', { name: /导入所选 1 项并继续/ }))
    await screen.findByRole('button', { name: /为工作台增加全局命令面板/ })
    expect(stored?.settings.runtimes[0]).toMatchObject({ enabled: true, executable: '/local/bin/codex' })
    expect(screen.queryByText('目标和任务可先记录；启动 Agent 前请配置本地 Runtime。')).toBeNull()
  })
})
