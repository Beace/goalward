// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppearanceTheme } from './use-appearance-theme'
import type { ThemePreference } from '@/lib/types'
import { normalizeThemePreference, syncNativeTheme, themeColorScheme } from '@/lib/theme'

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
    for (const value of [undefined, null, '', 'unknown', 'Cobalt2']) expect(normalizeThemePreference(value)).toBe('system')
    for (const value of ['system', 'dark', 'light', 'cobalt2']) expect(normalizeThemePreference(value)).toBe(value)
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

  it.each(['dark', 'light', 'cobalt2'] as const)('pins %s and resumes system updates when changed back', preference => {
    const { result, rerender } = renderHook(({ preference }: { preference: ThemePreference }) => useAppearanceTheme(preference), { initialProps: { preference: preference as ThemePreference } })
    expect(result.current).toBe(preference)
    expect(document.documentElement.dataset.theme).toBe(preference)
    expect(document.documentElement.dataset.themePreference).toBe(preference)
    expect(document.documentElement.classList.contains('dark')).toBe(preference !== 'light')
    expect(document.documentElement.style.colorScheme).toBe(themeColorScheme(preference))
    expect(listeners.size).toBe(0)
    changeSystem(true)
    expect(result.current).toBe(preference)
    changeSystem(false)
    expect(result.current).toBe(preference)
    rerender({ preference: 'system' })
    expect(result.current).toBe('light')
    expect(listeners.size).toBe(1)
    changeSystem(true)
    expect(result.current).toBe('dark')
    expect(document.documentElement.dataset.themePreference).toBe('system')
  })

  it.each(['dark', 'light', 'cobalt2'] as const)('maps %s to a supported native and toast color scheme', theme => {
    expect(themeColorScheme(theme)).toBe(theme === 'light' ? 'light' : 'dark')
  })

  it.each([
    ['200ms', 'dark', 'light'],
    ['.2s', 'dark', 'light'],
    ['200ms', 'cobalt2', 'dark'],
    ['.2s', 'cobalt2', 'dark'],
  ] as const)('restores immediately and keeps interruptible feedback for a %s CSS duration with saved %s', (duration, savedTheme, alternateTheme) => {
    vi.useFakeTimers()
    document.documentElement.style.setProperty('--motion-theme-duration', duration)
    const { rerender, unmount } = renderHook(({ preference, loaded }: { preference?: ThemePreference; loaded: boolean }) => useAppearanceTheme(preference, loaded), { initialProps: { preference: undefined as ThemePreference | undefined, loaded: false } })
    rerender({ preference: savedTheme, loaded: true })
    expect(document.documentElement.dataset.theme).toBe(savedTheme)
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    rerender({ preference: alternateTheme, loaded: true })
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    act(() => vi.advanceTimersByTime(50))
    rerender({ preference: savedTheme, loaded: true })
    expect(document.documentElement.dataset.theme).toBe(savedTheme)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    act(() => vi.advanceTimersByTime(199))
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['0ms', 'light'], ['0s', 'light'], ['0ms', 'cobalt2'], ['0s', 'cobalt2'],
  ] as const)('updates statically when reduced motion supplies %s and changes to %s', (duration, nextTheme) => {
    vi.useFakeTimers()
    document.documentElement.style.setProperty('--motion-theme-duration', duration)
    const { rerender } = renderHook(({ preference }: { preference: ThemePreference }) => useAppearanceTheme(preference), { initialProps: { preference: 'dark' as ThemePreference } })
    rerender({ preference: nextTheme })
    expect(document.documentElement.dataset.theme).toBe(nextTheme)
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes native overrides, maps Cobalt2 to dark, and resets native appearance with null for system', async () => {
    native.enabled = true
    let finish!: () => void
    native.setTheme.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const cobalt2 = syncNativeTheme('cobalt2')
    const light = syncNativeTheme('light')
    const system = syncNativeTheme('system')
    await Promise.resolve()
    expect(native.setTheme.mock.calls).toEqual([['dark']])
    finish()
    await Promise.all([cobalt2, light, system])
    expect(native.setTheme.mock.calls).toEqual([['dark'], ['light'], [null]])
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
