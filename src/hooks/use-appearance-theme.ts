import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { applyDocumentTheme, normalizeThemePreference, resolveTheme, syncNativeTheme, systemThemeQuery } from '@/lib/theme'
import type { ThemePreference } from '@/lib/types'

const systemMedia = () => typeof window.matchMedia === 'function' ? window.matchMedia(systemThemeQuery) : undefined

export function useAppearanceTheme(value?: ThemePreference, loaded = true) {
  const preference = normalizeThemePreference(value)
  const [theme, setTheme] = useState(() => resolveTheme(preference, systemMedia()?.matches ?? false))
  const hydrated = useRef(false)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    clearTimeout(transitionTimer.current)
    document.documentElement.classList.remove('theme-changing')
  }, [])

  useLayoutEffect(() => {
    const root = document.documentElement
    const media = systemMedia()
    function apply() {
      const next = resolveTheme(preference, media?.matches ?? false)
      const changed = root.dataset.theme && root.dataset.theme !== next
      if (hydrated.current && changed) {
        clearTimeout(transitionTimer.current)
        // CSS owns the color feedback parameters; no transition delays state or save.
        root.classList.add('theme-changing')
        const duration = Number.parseFloat(getComputedStyle(root).getPropertyValue('--motion-theme-duration')) || 0
        transitionTimer.current = setTimeout(() => root.classList.remove('theme-changing'), duration)
      }
      applyDocumentTheme(next, preference)
      setTheme(next)
      if (loaded) hydrated.current = true
    }
    apply()
    if (preference === 'system') media?.addEventListener('change', apply)
    if (loaded) void syncNativeTheme(preference).catch(error => console.warn('无法同步原生窗口主题：', error))
    return () => {
      media?.removeEventListener('change', apply)
    }
  }, [preference, loaded])
  return theme
}
