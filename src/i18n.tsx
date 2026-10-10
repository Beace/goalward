import { invoke, isTauri } from '@tauri-apps/api/core'
import { locale as systemLocale } from '@tauri-apps/plugin-os'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type Language = 'zh' | 'en'
export type LanguagePreference = Language | 'system'

/** Only Chinese has a translated UI. Every other system language uses English. */
export function languageFromLocale(locale: string | null | undefined): Language {
  return locale?.trim().split(/[-_]/, 1)[0]?.toLowerCase() === 'zh' ? 'zh' : 'en'
}

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === 'zh' || value === 'en' ? value : 'system'
}

export function effectiveLanguage(system: Language, preference: unknown): Language {
  const selected = normalizeLanguagePreference(preference)
  return selected === 'system' ? system : selected
}

function browserLocale(): string | null {
  return typeof navigator === 'undefined' ? null : navigator.language
}

async function currentSystemLanguage(): Promise<Language> {
  if (!isTauri()) return languageFromLocale(browserLocale())
  try {
    return languageFromLocale((await systemLocale()) ?? browserLocale())
  } catch {
    // The browser locale is only a fallback when the OS plugin is unavailable.
    return languageFromLocale(browserLocale())
  }
}

async function savedPreference(): Promise<LanguagePreference> {
  try {
    const state = isTauri()
      ? await invoke<{ settings?: { language?: unknown } } | null>('load_workspace_summary')
      : JSON.parse(localStorage.getItem('goalward.preview.v1') ?? localStorage.getItem('super-agents.preview.v1') ?? 'null') as { settings?: { language?: unknown } } | null
    return normalizeLanguagePreference(state?.settings?.language)
  } catch {
    // Workspace loading owns the user-facing storage error. Locale falls back
    // to the system choice so a damaged workspace cannot block the window.
    return 'system'
  }
}

// Legacy unit tests call projection helpers without mounting the app provider.
// Production always follows the browser/OS locale until a saved override loads.
let currentLanguage: Language = import.meta.env.MODE === 'test' ? 'zh' : languageFromLocale(browserLocale())

export function getCurrentLanguage(): Language { return currentLanguage }
export function translate(zh: string, en: string): string { return currentLanguage === 'zh' ? zh : en }

interface I18nValue {
  language: Language
  t: (zh: string, en: string) => string
  setPreference: (value: LanguagePreference) => void
}

const fallbackLanguage: Language = import.meta.env.MODE === 'test' ? 'zh' : languageFromLocale(browserLocale())
const fallback: I18nValue = {
  // Components rendered in isolation by tests retain the project's original locale.
  language: fallbackLanguage,
  t: (zh, en) => fallbackLanguage === 'zh' ? zh : en,
  setPreference: () => {},
}
const I18nContext = createContext<I18nValue>(fallback)

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [system, setSystem] = useState<Language>(() => languageFromLocale(browserLocale()))
  const [preference, setPreferenceState] = useState<LanguagePreference>('system')
  const [ready, setReady] = useState(false)
  const initialDocumentLanguage = useRef(document.documentElement.lang)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      currentSystemLanguage(),
      // Read the saved override before mounting App so the initial UI does not
      // briefly render in the system language when a manual choice exists.
      savedPreference(),
    ]).then(([systemLanguage, savedPreference]) => {
      if (cancelled) return
      setSystem(systemLanguage)
      setPreferenceState(savedPreference)
      setReady(true)
    })
    return () => { cancelled = true }
  }, [])

  const setPreference = useCallback((value: LanguagePreference) => {
    setPreferenceState(normalizeLanguagePreference(value))
  }, [])
  useEffect(() => {
    if (!ready || preference !== 'system') return
    let cancelled = false
    const refresh = () => { void currentSystemLanguage().then(next => { if (!cancelled) setSystem(next) }) }
    refresh()
    window.addEventListener('languagechange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('languagechange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [ready, preference])
  const language = effectiveLanguage(system, preference)
  // Non-React projections use translate(). Keep them in sync before children render.
  currentLanguage = language
  useLayoutEffect(() => {
    currentLanguage = language
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])
  useLayoutEffect(() => {
    return () => {
      currentLanguage = import.meta.env.MODE === 'test' ? 'zh' : languageFromLocale(browserLocale())
      document.documentElement.lang = initialDocumentLanguage.current
    }
  }, [])
  const value = useMemo<I18nValue>(() => ({
    language,
    t: (zh, en) => language === 'zh' ? zh : en,
    setPreference,
  }), [language, setPreference])

  return ready ? <I18nContext.Provider value={value}>{children}</I18nContext.Provider> : null
}
