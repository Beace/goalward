// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({ value: false, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => desktop.value, invoke: desktop.invoke }))

beforeEach(() => {
  desktop.value = false
  desktop.invoke.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('external web links', () => {
  it('normalizes absolute web URLs and rejects unsafe schemes, credentials and controls', async () => {
    const { normalizeExternalHttpUrl } = await import('./bridge')
    expect(normalizeExternalHttpUrl('HTTPS://example.com/中文?q=a%20b#section')).toBe('https://example.com/%E4%B8%AD%E6%96%87?q=a%20b#section')
    expect(normalizeExternalHttpUrl('http://127.0.0.1:1420/')).toBe('http://127.0.0.1:1420/')
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'mailto:a@example.com', 'codex://threads/test', '/tmp/report.html', '//example.com', 'https:example.com', 'https://user:password@example.com', 'https://user@example.com', ' https://example.com', 'https://example.com/a b', 'https://example.com\n', 'https://example.com\0', 'https://', '--args', '']) {
      expect(normalizeExternalHttpUrl(value), value).toBeNull()
    }
    expect(normalizeExternalHttpUrl('https://example.com/\u0085')).toBeNull()
  })

  it('uses the scoped native command and does not navigate the app webview', async () => {
    desktop.value = true
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { openExternalUrl } = await import('./bridge')
    await openExternalUrl('https://example.com/docs')
    expect(desktop.invoke).toHaveBeenCalledExactlyOnceWith('open_external_url', { url: 'https://example.com/docs' })
    expect(open).not.toHaveBeenCalled()
    await expect(openExternalUrl('file:///tmp/report.html')).rejects.toThrow('HTTP')
    expect(desktop.invoke).toHaveBeenCalledTimes(1)
  })

  it('opens preview links in an isolated browser tab and surfaces native failures', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    let bridge = await import('./bridge')
    await bridge.openExternalUrl('https://example.com/')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/', '_blank', 'noopener,noreferrer')
    expect(desktop.invoke).not.toHaveBeenCalled()
    desktop.value = true
    vi.resetModules()
    bridge = await import('./bridge')
    desktop.invoke.mockRejectedValueOnce(new Error('fixture browser unavailable'))
    await expect(bridge.openExternalUrl('https://example.com/')).rejects.toThrow('fixture browser unavailable')
  })
})
