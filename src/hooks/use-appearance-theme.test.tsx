// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppearanceTheme } from './use-appearance-theme'
import type { ThemePreference } from '@/lib/types'
import { normalizeThemePreference, syncNativeTheme } from '@/lib/theme'

const native = vi.hoisted(() => ({ enabled: false, setTheme: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: native.setTheme }) }))
const listeners = new Set<() => void>()
let media: MediaQueryList
function changeSystem(dark: boolean) {
  Object.defineProperty(media, 'matches', { configurable: true, value: dark })
  act(() => listeners.forEach(listener => listener()))
}
beforeEach(() => {
  vi.clearAllMocks(); native.enabled = false
  native.setTheme.mockResolvedValue(undefined)
  listeners.clear()
  media = {
    matches: false,
    addEventListener: (_: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.setProperty('--motion-theme-duration', '200ms')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('saved global appearance', () => {
  it('defaults legacy and invalid preferences to system without rewriting settings', () => {
    for (const value of [undefined, null, '', 'unknown']) expect(normalizeThemePreference(value)).toBe('system')
    const { result, unmount } = renderHook(() => useAppearanceTheme())
    expect(result.current).toBe('light')
    expect(document.documentElement.dataset.themePreference).toBe('system')
    expect(listeners.size).toBe(1)
    changeSystem(true)
    expect(result.current).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('pins both explicit modes and resumes system updates when changed back', () => {
    const { result, rerender } = renderHook(({ preference }: { preference: ThemePreference }) => useAppearanceTheme(preference), { initialProps: { preference: 'dark' as ThemePreference } })
    expect(result.current).toBe('dark')
    expect(listeners.size).toBe(0)
    changeSystem(false)
    expect(result.current).toBe('dark')
    rerender({ preference: 'light' })
    changeSystem(true)
    expect(result.current).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    rerender({ preference: 'system' })
    expect(result.current).toBe('dark')
    expect(listeners.size).toBe(1)
    changeSystem(false)
    expect(result.current).toBe('light')
  })

  it('restores the loaded preference immediately and retargets later feedback', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = renderHook(({ preference, loaded }: { preference?: ThemePreference; loaded: boolean }) => useAppearanceTheme(preference, loaded), { initialProps: { preference: undefined as ThemePreference | undefined, loaded: false } })
    rerender({ preference: 'dark', loaded: true })
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    rerender({ preference: 'light', loaded: true })
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    act(() => vi.advanceTimersByTime(50))
    rerender({ preference: 'dark', loaded: true })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    act(() => vi.advanceTimersByTime(200))
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes native overrides and resets native appearance with null for system', async () => {
    native.enabled = true
    let finish!: () => void
    native.setTheme.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const dark = syncNativeTheme('dark')
    const system = syncNativeTheme('system')
    await Promise.resolve()
    expect(native.setTheme.mock.calls).toEqual([['dark']])
    finish()
    await Promise.all([dark, system])
    expect(native.setTheme.mock.calls).toEqual([['dark'], [null]])
  })

  it('finishes color feedback when a rapid preference change resolves to the same theme', () => {
    vi.useFakeTimers()
    changeSystem(true)
    const { rerender } = renderHook(({ preference }: { preference: ThemePreference }) => useAppearanceTheme(preference), { initialProps: { preference: 'light' as ThemePreference } })
    rerender({ preference: 'dark' })
    act(() => vi.advanceTimersByTime(50))
    rerender({ preference: 'system' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    act(() => vi.advanceTimersByTime(200))
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
  })
})
