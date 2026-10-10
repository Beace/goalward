// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_UPDATE_CHECK_INTERVAL, useAppUpdate } from './use-app-update'
import type { AppUpdateDownloadEvent } from '@/lib/app-update'

const bridge = vi.hoisted(() => ({ isDesktop: true }))
const api = vi.hoisted(() => ({ checkAppUpdate: vi.fn(), downloadAppUpdate: vi.fn(), installAppUpdate: vi.fn(), restartAfterAppUpdate: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/lib/app-update', () => api)
const release = { currentVersion: '0.2.0', version: '0.3.0', notes: 'Release notes', releaseUrl: 'https://github.com/example/goalward/releases/tag/v0.3.0' }
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function mount(ready = true) {
  const onAvailable = vi.fn()
  const canApplyUpdate = vi.fn(() => true)
  const hook = renderHook(({ ready }) => useAppUpdate({ ready, onAvailable, canApplyUpdate }), { initialProps: { ready } })
  return { ...hook, onAvailable, canApplyUpdate }
}
async function settle() { await act(async () => {}) }
async function download(hook: ReturnType<typeof mount>) { await act(async () => { await hook.result.current.download() }) }

beforeEach(() => {
  vi.clearAllMocks()
  bridge.isDesktop = true
  api.checkAppUpdate.mockResolvedValue(release)
  api.downloadAppUpdate.mockResolvedValue(undefined)
  api.installAppUpdate.mockResolvedValue(undefined)
  api.restartAfterAppUpdate.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('application updates', () => {
  it('waits for app state, checks every six hours and only notifies once per version', async () => {
    vi.useFakeTimers()
    const hook = mount(false)
    expect(api.checkAppUpdate).not.toHaveBeenCalled()
    hook.rerender({ ready: true })
    await settle()
    expect(hook.result.current.phase).toBe('available')
    expect(hook.onAvailable).toHaveBeenCalledOnce()
    await act(async () => { vi.advanceTimersByTime(APP_UPDATE_CHECK_INTERVAL) })
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(2)
    expect(hook.onAvailable).toHaveBeenCalledOnce()
    api.checkAppUpdate.mockResolvedValue({ ...release, version: '0.4.0' })
    await act(async () => { vi.advanceTimersByTime(APP_UPDATE_CHECK_INTERVAL) })
    expect(hook.onAvailable).toHaveBeenCalledTimes(2)
    expect(hook.result.current.info.version).toBe('0.4.0')
    hook.unmount()
    await act(async () => { vi.advanceTimersByTime(APP_UPDATE_CHECK_INTERVAL) })
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(3)
  })

  it('never invokes native commands from browser preview', async () => {
    bridge.isDesktop = false
    const hook = mount()
    await act(async () => { await hook.result.current.check(); await hook.result.current.download(); await hook.result.current.install(); await hook.result.current.restart() })
    expect(hook.result.current.desktop).toBe(false)
    expect(api.checkAppUpdate).not.toHaveBeenCalled()
    expect(api.downloadAppUpdate).not.toHaveBeenCalled()
    expect(api.installAppUpdate).not.toHaveBeenCalled()
    expect(api.restartAfterAppUpdate).not.toHaveBeenCalled()
  })

  it('keeps network failure distinct from a successful latest-version result and retries quietly', async () => {
    api.checkAppUpdate.mockRejectedValue(new Error('Network unavailable'))
    const hook = mount()
    await settle()
    expect(hook.result.current.phase).toBe('idle')
    expect(hook.result.current.checkedAt).toBeUndefined()
    expect(hook.result.current.error).toEqual({ stage: 'check', message: 'Network unavailable' })
    expect(hook.onAvailable).not.toHaveBeenCalled()
    api.checkAppUpdate.mockResolvedValue({ currentVersion: '0.2.0' })
    await act(async () => { await hook.result.current.check() })
    expect(hook.result.current.phase).toBe('current')
    expect(hook.result.current.checkedAt).toBeTruthy()
    expect(hook.result.current.error).toBeUndefined()
  })

  it('reports native byte progress, prevents concurrent work and waits for signature verification', async () => {
    const hook = mount()
    await settle()
    const pending = deferred()
    let receive!: (event: AppUpdateDownloadEvent) => void
    api.downloadAppUpdate.mockImplementation((handler: typeof receive) => { receive = handler; return pending.promise })
    let operation!: Promise<void>
    act(() => { operation = hook.result.current.download() })
    act(() => { receive({ event: 'Started', data: { contentLength: 100 } }); receive({ event: 'Progress', data: { chunkLength: 40 } }); receive({ event: 'Progress', data: { chunkLength: 60 } }); receive({ event: 'Finished' }) })
    expect(hook.result.current.downloadedBytes).toBe(100)
    expect(hook.result.current.totalBytes).toBe(100)
    expect(hook.result.current.phase).toBe('downloading')
    await act(async () => { await hook.result.current.check(); await hook.result.current.download(); await hook.result.current.install() })
    expect(api.checkAppUpdate).toHaveBeenCalledOnce()
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce()
    expect(api.installAppUpdate).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(); await operation })
    expect(hook.result.current.phase).toBe('downloaded')
    act(() => { receive({ event: 'Progress', data: { chunkLength: 99 } }) })
    expect(hook.result.current.downloadedBytes).toBe(100)
  })

  it('resets failed download progress on retry', async () => {
    const hook = mount()
    await settle()
    api.downloadAppUpdate.mockImplementation(async (receive: (event: AppUpdateDownloadEvent) => void) => { receive({ event: 'Progress', data: { chunkLength: 100 } }); throw new Error('Invalid signature') })
    await download(hook)
    expect(hook.result.current.phase).toBe('available')
    expect(hook.result.current.error?.stage).toBe('download')
    api.downloadAppUpdate.mockImplementation(async (receive: (event: AppUpdateDownloadEvent) => void) => { receive({ event: 'Progress', data: { chunkLength: 25 } }) })
    await download(hook)
    expect(hook.result.current.downloadedBytes).toBe(25)
    expect(hook.result.current.phase).toBe('downloaded')
    expect(hook.result.current.error).toBeUndefined()
  })

  it('allows a manual recheck after a failed download and downloads the newly selected release', async () => {
    let selectedNativeVersion = release.version
    const downloadedVersions: string[] = []
    api.checkAppUpdate.mockImplementation(async () => ({ ...release, version: selectedNativeVersion }))
    api.downloadAppUpdate.mockImplementation(async () => {
      downloadedVersions.push(selectedNativeVersion)
      if (selectedNativeVersion === release.version) throw new Error('Selected release is no longer available')
    })
    const hook = mount()
    await settle()
    await download(hook)
    expect(hook.result.current.phase).toBe('available')
    expect(hook.result.current.error?.stage).toBe('download')
    selectedNativeVersion = '0.4.0'
    await act(async () => { await hook.result.current.check() })
    expect(hook.result.current.info.version).toBe('0.4.0')
    expect(hook.result.current.error).toBeUndefined()
    expect(hook.result.current.downloadedBytes).toBe(0)
    await download(hook)
    expect(downloadedVersions).toEqual(['0.3.0', '0.4.0'])
    expect(hook.result.current.phase).toBe('downloaded')
    expect(hook.result.current.info.version).toBe('0.4.0')
  })

  it('rechecks a failed download every six hours without replacing a verified download', async () => {
    vi.useFakeTimers()
    const hook = mount()
    await settle()
    api.downloadAppUpdate.mockRejectedValueOnce(new Error('Release disappeared'))
    await download(hook)
    api.checkAppUpdate.mockResolvedValue({ ...release, version: '0.4.0' })
    await act(async () => { vi.advanceTimersByTime(APP_UPDATE_CHECK_INTERVAL) })
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(2)
    expect(hook.result.current.info.version).toBe('0.4.0')
    expect(hook.result.current.error).toBeUndefined()
    await download(hook)
    expect(hook.result.current.phase).toBe('downloaded')
    await act(async () => { vi.advanceTimersByTime(APP_UPDATE_CHECK_INTERVAL) })
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(2)
    expect(hook.result.current.info.version).toBe('0.4.0')
  })

  it('rechecks task and settings guards at click time, retries install/restart in place and never auto restarts', async () => {
    const hook = mount()
    await settle()
    await download(hook)
    hook.canApplyUpdate.mockReturnValue(false)
    await act(async () => { await hook.result.current.install() })
    expect(api.installAppUpdate).not.toHaveBeenCalled()
    hook.canApplyUpdate.mockReturnValue(true)
    api.installAppUpdate.mockRejectedValueOnce(new Error('Busy native runtime'))
    await act(async () => { await hook.result.current.install() })
    expect(hook.result.current.phase).toBe('downloaded')
    expect(hook.result.current.error?.stage).toBe('install')
    await act(async () => { await hook.result.current.install() })
    expect(hook.result.current.phase).toBe('installed')
    expect(api.restartAfterAppUpdate).not.toHaveBeenCalled()
    hook.canApplyUpdate.mockReturnValue(false)
    await act(async () => { await hook.result.current.restart() })
    expect(api.restartAfterAppUpdate).not.toHaveBeenCalled()
    hook.canApplyUpdate.mockReturnValue(true)
    api.restartAfterAppUpdate.mockRejectedValueOnce(new Error('Could not relaunch'))
    await act(async () => { await hook.result.current.restart() })
    expect(hook.result.current.phase).toBe('installed')
    expect(hook.result.current.error?.stage).toBe('restart')
    await act(async () => { await hook.result.current.download(); await hook.result.current.install(); await hook.result.current.check(); await hook.result.current.restart() })
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce()
    expect(api.installAppUpdate).toHaveBeenCalledTimes(2)
    expect(api.checkAppUpdate).toHaveBeenCalledOnce()
    expect(api.restartAfterAppUpdate).toHaveBeenCalledTimes(2)
  })
})
