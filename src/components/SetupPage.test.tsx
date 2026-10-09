// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupPage, { type SetupPageProps } from './SetupPage'
import type { DiscoveredRuntime, LocalDiscoveryReport, Settings } from '@/lib/types'

const settings: Settings = { runtimes: [], models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '', outputLimit: 65536 }
const discovered = (id: string, name: string, found = true, error = ''): DiscoveredRuntime => ({
  id, name, executable: id, adapter: id === 'codex' || id === 'claude' ? id : 'generic',
  probe: { found, error, path: found ? `/opt/homebrew/bin/${id}` : '', version: found && !error ? `${name} 1.2.3` : '' },
  models: [], configSources: [], warnings: [],
})
const report = (overrides: Partial<DiscoveredRuntime>[] = []): LocalDiscoveryReport => ({ scannedAt: '2026-09-15T00:00:00Z', runtimes: [
  discovered('codex', 'Codex'), discovered('claude', 'Claude Code'), discovered('traex', 'TraeX'), discovered('deepseek-harness', 'DeepSeek Harness', false),
].map((runtime, index) => ({ ...runtime, ...overrides[index] })) })

function props(patch: Partial<SetupPageProps> = {}): SetupPageProps {
  return { report: report(), scanning: false, error: '', busy: false, settings, mode: 'first-run', onRescan: vi.fn(), onImport: vi.fn(async () => {}), onConfigure: vi.fn(), onLater: vi.fn(async () => {}), ...patch }
}
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('first-run discovery view', () => {
  it('shows pending detection without invented ready states and allows deferring during a scan', async () => {
    const handlers = props({ report: null, scanning: true })
    render(<SetupPage {...handlers} />)
    expect(screen.getAllByText('检测中')).toHaveLength(5)
    expect(screen.queryByText('已找到')).toBeNull()
    expect((screen.getByRole('button', { name: /导入所选/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '稍后配置' }))
    await waitFor(() => expect(handlers.onLater).toHaveBeenCalledTimes(1))
    expect(handlers.onImport).not.toHaveBeenCalled()
  })

  it('provides installation, login and rescan guidance when every runtime is missing, with no empty import action', () => {
    const empty = report()
    empty.runtimes = empty.runtimes.map(runtime => ({ ...runtime, probe: { found: false, path: '', version: '' } }))
    const handlers = props({ report: empty })
    render(<SetupPage {...handlers} />)
    expect(screen.getByText('安装 Agent Runtime')).toBeTruthy()
    expect(screen.getByText('完成登录与模型配置')).toBeTruthy()
    expect(screen.getByText('重新检测并导入')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /导入所选/ })).toBeNull()
    expect(screen.getAllByRole('checkbox').every(element => (element as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: '手动配置' })[0])
    expect(handlers.onConfigure).toHaveBeenCalledWith('codex', 'runtimes')
    fireEvent.click(screen.getAllByRole('button', { name: '重新检测' })[0])
    expect(handlers.onRescan).toHaveBeenCalledTimes(1)
  })

  it('preselects working built-in adapters, imports checked IDs and repairs the default after deselection', async () => {
    const handlers = props()
    render(<SetupPage {...handlers} />)
    expect(screen.getByRole('checkbox', { name: '导入 Codex' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '导入 Claude Code' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '导入 TraeX' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox', { name: '导入 Codex' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '导入 TraeX' }))
    expect(screen.getByRole('combobox', { name: '默认 Runtime' }).textContent).toBe('Claude Code')
    fireEvent.click(screen.getByRole('button', { name: /导入所选 2 项并继续/ }))
    await waitFor(() => expect(handlers.onImport).toHaveBeenCalledWith(['claude', 'traex'], 'claude'))
  })

  it('shows model identity, selected default and source, while the empty case explains runtime defaults', () => {
    const handlers = props({ report: report([{ models: [{ modelId: 'local-model-id', name: '本机模型', source: '~/.codex/config.toml', selected: true }] }]) })
    render(<SetupPage {...handlers} />)
    expect(screen.getByText('local-model-id')).toBeTruthy()
    expect(screen.getByText('本机配置默认')).toBeTruthy()
    expect(screen.getByText('~/.codex/config.toml')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 Claude Code 检测详情' }))
    expect(screen.getByText('未读到显式模型')).toBeTruthy()
    expect(screen.getByText('可沿用 Runtime 自身默认，也可手动配置。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '配置模型' }))
    expect(handlers.onConfigure).toHaveBeenCalledWith('claude', 'models')
    expect(screen.getByRole('checkbox', { name: '导入 Codex' }).getAttribute('aria-checked')).toBe('true')
  })

  it('distinguishes failed version probes from missing executables and permits explicit path import without a default', async () => {
    const source = report([{ probe: { found: true, path: '/custom/codex', version: '', error: '版本检查超时' } }, { probe: { found: false, path: '', version: '' } }])
    const handlers = props({ report: source })
    render(<SetupPage {...handlers} />)
    expect(screen.getByText('找到程序，但版本检测未成功')).toBeTruthy()
    expect(screen.getByText('版本检查超时')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '导入 Codex' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('checkbox', { name: '导入 Codex' }))
    fireEvent.click(screen.getByRole('button', { name: /导入所选 1 项并继续/ }))
    await waitFor(() => expect(handlers.onImport).toHaveBeenCalledWith(['codex'], ''))
  })

  it('allows keyboard opening and selection of a default, and restores focus after dismissal', async () => {
    render(<SetupPage {...props()} />)
    const trigger = screen.getByRole('combobox', { name: '默认 Runtime' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const option = await screen.findByRole('option', { name: 'Claude Code' })
    option.focus()
    fireEvent.keyDown(option, { key: 'Enter' })
    await waitFor(() => expect(trigger.textContent).toBe('Claude Code'))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps failed imports reviewable and prevents duplicate submissions until persistence resolves', async () => {
    let reject!: (cause: Error) => void
    const pending = new Promise<void>((_, fail) => { reject = fail })
    const handlers = props({ onImport: vi.fn(() => pending) })
    render(<SetupPage {...handlers} />)
    const importButton = screen.getByRole('button', { name: /导入所选 2 项并继续/ })
    fireEvent.click(importButton)
    fireEvent.click(importButton)
    expect(handlers.onImport).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('无法保存配置')) })
    expect(screen.getByRole('alert').textContent).toContain('无法保存配置')
    expect((screen.getByRole('button', { name: /导入所选 2 项并继续/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('checkbox', { name: '导入 Codex' }).getAttribute('aria-checked')).toBe('true')
  })
})
