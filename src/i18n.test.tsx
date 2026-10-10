// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, effectiveLanguage, getCurrentLanguage, languageFromLocale, normalizeLanguagePreference, translate, useI18n } from './i18n'

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }))
const os = vi.hoisted(() => ({ locale: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => tauri)
vi.mock('@tauri-apps/plugin-os', () => os)

function Probe() {
  const { language, t, setPreference } = useI18n()
  return <div>
    <span data-testid="language">{language}</span>
    <span data-testid="text">{t('中文', 'English')}</span>
    <button onClick={() => setPreference('en')}>English</button>
    <button onClick={() => setPreference('system')}>System</button>
  </div>
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  tauri.isTauri.mockReturnValue(true)
  tauri.invoke.mockResolvedValue({ settings: {} })
  os.locale.mockResolvedValue('zh-Hans-CN')
})
afterEach(() => { cleanup(); document.documentElement.lang = 'en' })

describe('locale selection', () => {
  it('uses Chinese for any Chinese system tag and English for every other language', () => {
    expect(languageFromLocale('zh-CN')).toBe('zh')
    expect(languageFromLocale('zh-Hant-TW')).toBe('zh')
    expect(languageFromLocale('ZH_hans_CN')).toBe('zh')
    expect(languageFromLocale('en-US')).toBe('en')
    expect(languageFromLocale('fr-FR')).toBe('en')
    expect(languageFromLocale(null)).toBe('en')
  })

  it('accepts only saved Chinese or English as overrides', () => {
    expect(normalizeLanguagePreference('zh')).toBe('zh')
    expect(normalizeLanguagePreference('en')).toBe('en')
    expect(normalizeLanguagePreference('fr')).toBe('system')
    expect(effectiveLanguage('zh', undefined)).toBe('zh')
    expect(effectiveLanguage('zh', 'en')).toBe('en')
    expect(effectiveLanguage('en', 'zh')).toBe('zh')
  })

  it('reads native system locale and saved override before rendering children', async () => {
    let resolveLocale!: (value: string) => void
    os.locale.mockReturnValue(new Promise<string>(resolve => { resolveLocale = resolve }))
    tauri.invoke.mockResolvedValue({ settings: { language: 'zh' } })
    const view = render(<I18nProvider><Probe /></I18nProvider>)
    expect(screen.queryByTestId('language')).toBeNull()
    resolveLocale('en-US')
    expect((await screen.findByTestId('language')).textContent).toBe('zh')
    expect(screen.getByTestId('text').textContent).toBe('中文')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(translate('中文', 'English')).toBe('中文')
    expect(tauri.invoke).toHaveBeenCalledWith('load_workspace_summary')
    fireEvent.click(screen.getByText('English'))
    expect(getCurrentLanguage()).toBe('en')
    expect(translate('中文', 'English')).toBe('English')
    expect(document.documentElement.lang).toBe('en')
    fireEvent.click(screen.getByText('System'))
    expect(screen.getByTestId('language').textContent).toBe('en')
    view.unmount()
    expect(getCurrentLanguage()).toBe('zh')
    expect(translate('中文', 'English')).toBe('中文')
  })

  it('uses English for unsupported OS locales in browser preview', async () => {
    tauri.isTauri.mockReturnValue(false)
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'fr-FR' })
    render(<I18nProvider><Probe /></I18nProvider>)
    expect((await screen.findByTestId('language')).textContent).toBe('en')
    expect(screen.getByTestId('text').textContent).toBe('English')
    expect(os.locale).not.toHaveBeenCalled()
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it('honors a saved browser-preview override before mounting children', async () => {
    tauri.isTauri.mockReturnValue(false)
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'fr-FR' })
    localStorage.setItem('goalward.preview.v1', JSON.stringify({ settings: { language: 'zh' } }))
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(screen.queryByTestId('language')).toBeNull()
    expect((await screen.findByTestId('language')).textContent).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('refreshes a system choice when the window regains focus', async () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    expect((await screen.findByTestId('language')).textContent).toBe('zh')
    os.locale.mockResolvedValue('fr-FR')
    fireEvent.focus(window)
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('en'))
  })
})
