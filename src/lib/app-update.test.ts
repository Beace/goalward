import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkAppUpdate, downloadAppUpdate, installAppUpdate, restartAfterAppUpdate } from './app-update'
const bridge = vi.hoisted(() => ({ isDesktop: true }))
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./bridge', () => bridge)
vi.mock('@tauri-apps/api/core', () => ({ ...native, Channel: class { onmessage?: (event: unknown) => void } }))
beforeEach(() => { vi.clearAllMocks(); bridge.isDesktop = true; native.invoke.mockResolvedValue(undefined) })
describe('native update bridge', () => {
  it('forwards the exact native DTO and channel, and keeps install and restart separate', async () => {
    const info = { currentVersion: '0.2.0', version: '0.3.0' }
    native.invoke.mockResolvedValueOnce(info)
    expect(await checkAppUpdate()).toBe(info)
    const receive = vi.fn()
    await downloadAppUpdate(receive)
    const channel = native.invoke.mock.calls[1][1].onEvent
    channel.onmessage({ event: 'Progress', data: { chunkLength: 10 } })
    expect(receive).toHaveBeenCalledWith({ event: 'Progress', data: { chunkLength: 10 } })
    await installAppUpdate()
    await restartAfterAppUpdate()
    expect(native.invoke.mock.calls.map(call => call[0])).toEqual(['check_app_update', 'download_app_update', 'install_app_update', 'restart_app_after_update'])
  })
  it('rejects every mutation and check in browser preview before native invocation', async () => {
    bridge.isDesktop = false
    for (const operation of [checkAppUpdate, () => downloadAppUpdate(vi.fn()), installAppUpdate, restartAfterAppUpdate]) await expect(operation()).rejects.toThrow('desktop app')
    expect(native.invoke).not.toHaveBeenCalled()
  })
})
