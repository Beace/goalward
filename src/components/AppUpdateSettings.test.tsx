// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateSettings } from './AppUpdateSettings'
import type { AppUpdateController } from '@/hooks/use-app-update'
const bridge = vi.hoisted(() => ({ openExternalUrl: vi.fn() }))
const notices = vi.hoisted(() => ({ notify: { error: vi.fn() } }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/ui/sonner', () => notices)
function controller(overrides: Partial<AppUpdateController> = {}): AppUpdateController {
  return { phase: 'idle', info: { currentVersion: '0.2.0' }, desktop: true, downloadedBytes: 0, check: vi.fn(async () => {}), download: vi.fn(async () => {}), install: vi.fn(async () => {}), restart: vi.fn(async () => {}), ...overrides }
}
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' }) })
afterEach(cleanup)
describe('app update settings', () => {
  it('disables native checks in the browser and explains the desktop boundary', () => {
    const update = controller({ desktop: false })
    render(<AppUpdateSettings update={update} activeCount={0} unsaved={false} />)
    const check = screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement
    expect(check.disabled).toBe(true)
    fireEvent.click(check)
    expect(update.check).not.toHaveBeenCalled()
    expect(screen.getByText(/浏览器提供界面预览/)).toBeTruthy()
  })
  it('shows real progress and exposes only the appropriate retry stage after install and restart failure', () => {
    const update = controller({ phase: 'downloading', totalBytes: 100, downloadedBytes: 50 })
    const view = render(<AppUpdateSettings update={update} activeCount={0} unsaved={false} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    view.rerender(<AppUpdateSettings update={{ ...update, phase: 'downloaded', error: { stage: 'install', message: 'Install failed' } }} activeCount={0} unsaved={false} />)
    expect(screen.queryByRole('button', { name: '下载更新' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试安装' }))
    expect(update.install).toHaveBeenCalledOnce()
    view.rerender(<AppUpdateSettings update={{ ...update, phase: 'installed', error: { stage: 'restart', message: 'Restart failed' } }} activeCount={0} unsaved={false} />)
    expect(screen.queryByRole('button', { name: '重试安装' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试重启' }))
    expect(update.restart).toHaveBeenCalledOnce()
  })
  it('keeps installation disabled for active runtimes, orchestration and settings drafts', () => {
    const update = controller({ phase: 'downloaded' })
    const view = render(<AppUpdateSettings update={update} activeCount={2} unsaved={false} />)
    expect((screen.getByRole('button', { name: '安装更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/2 个执行实例/)).toBeTruthy()
    view.rerender(<AppUpdateSettings update={update} activeCount={0} tasksBusy unsaved={false} />)
    expect((screen.getByRole('button', { name: '安装更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/等待任务编排结束/)).toBeTruthy()
    view.rerender(<AppUpdateSettings update={update} activeCount={0} unsaved />)
    expect((screen.getByRole('button', { name: '安装更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/请先保存或还原设置更改/)).toBeTruthy()
    view.rerender(<AppUpdateSettings update={update} activeCount={0} unsaved={false} />)
    fireEvent.click(screen.getByRole('button', { name: '安装更新' }))
    expect(update.install).toHaveBeenCalledOnce()
    expect(update.restart).not.toHaveBeenCalled()
  })
  it('shows a readable error when the GitHub release link cannot be opened', async () => {
    bridge.openExternalUrl.mockRejectedValue(new Error('Browser unavailable'))
    const update = controller({ phase: 'available', info: { currentVersion: '0.2.0', version: '0.3.0', releaseUrl: 'https://github.com/example/app/releases/tag/v0.3.0' } })
    render(<AppUpdateSettings update={update} activeCount={0} unsaved={false} />)
    fireEvent.click(screen.getByRole('button', { name: '查看 GitHub Release' }))
    await waitFor(() => expect(notices.notify.error).toHaveBeenCalledWith('无法打开版本页面：Browser unavailable'))
  })
})
