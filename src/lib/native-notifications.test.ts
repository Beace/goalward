import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(), isPermissionGranted: vi.fn(), requestPermission: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: api.isTauri }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: api.isPermissionGranted, requestPermission: api.requestPermission }))
const notification = { title: '对话已结束', body: '测试任务：本轮回复已完成。' }

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  api.isTauri.mockReturnValue(true)
  api.isPermissionGranted.mockResolvedValue(true)
  api.invoke.mockResolvedValue(undefined)
})

describe('native notification transport', () => {
  it('does nothing in browser preview', async () => {
    api.isTauri.mockReturnValue(false)
    const { sendNativeNotification } = await import('./native-notifications')
    await sendNativeNotification(notification)
    expect(api.isPermissionGranted).not.toHaveBeenCalled()
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('submits through the native plugin and propagates native errors', async () => {
    const { sendNativeNotification } = await import('./native-notifications')
    await sendNativeNotification(notification)
    expect(api.invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: notification })
    expect(api.requestPermission).not.toHaveBeenCalled()
    api.invoke.mockRejectedValueOnce(new Error('OS service unavailable'))
    await expect(sendNativeNotification(notification)).rejects.toThrow('OS service unavailable')
  })

  it('shares permission requests across simultaneous completions without dropping either notification', async () => {
    api.isPermissionGranted.mockResolvedValue(false)
    let grant!: (value: string) => void
    api.requestPermission.mockImplementation(() => new Promise(resolve => { grant = resolve }))
    const { sendNativeNotification } = await import('./native-notifications')
    const first = sendNativeNotification(notification)
    const second = sendNativeNotification({ ...notification, body: '另一任务' })
    await vi.waitFor(() => expect(api.requestPermission).toHaveBeenCalledTimes(1))
    expect(api.invoke).not.toHaveBeenCalled()
    grant('granted')
    await Promise.all([first, second])
    expect(api.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not repeatedly prompt after denial, but honors a later system permission change', async () => {
    api.isPermissionGranted.mockResolvedValue(false)
    api.requestPermission.mockResolvedValue('denied')
    const { sendNativeNotification } = await import('./native-notifications')
    await sendNativeNotification(notification)
    await sendNativeNotification(notification)
    expect(api.requestPermission).toHaveBeenCalledTimes(1)
    expect(api.invoke).not.toHaveBeenCalled()
    api.isPermissionGranted.mockResolvedValue(true)
    await sendNativeNotification(notification)
    expect(api.invoke).toHaveBeenCalledTimes(1)
  })
})
