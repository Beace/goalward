import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ThemePreference } from './types'

export type ResolvedTheme = 'dark' | 'light'
export const systemThemeQuery = '(prefers-color-scheme: dark)'

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'dark' || value === 'light' ? value : 'system'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function applyDocumentTheme(theme: ResolvedTheme, preference: ThemePreference) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.themePreference = preference
  root.classList.toggle('dark', theme === 'dark')
  // Native form controls and embedded color-scheme-aware SVGs follow the app.
  root.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
    getComputedStyle(root).getPropertyValue('--background').trim())
}

let nativeThemeQueue = Promise.resolve()
/** Serialize native updates so a late response cannot restore an older choice. */
export function syncNativeTheme(preference: ThemePreference): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  const job = nativeThemeQueue.then(() => getCurrentWindow().setTheme(preference === 'system' ? null : preference))
  nativeThemeQueue = job.catch(() => {})
  return job
}
