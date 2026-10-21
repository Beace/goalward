// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { readFileSync } from 'node:fs'
import { localizeNativeDiagnostic, localizeNativeModelSource, nativeDiagnosticCodes, nativeDiagnosticDetailCodes, nativeSourceCodes, nativeSourceDetailCodes } from '@/lib/native-diagnostics'
import type { LocalDiscoveryReport, Settings } from '@/lib/types'
import SetupPage from './SetupPage'
import { SettingsPage } from './SettingsPage'

vi.mock('@/lib/bridge', () => ({
  isDesktop: true,
  chooseDirectory: vi.fn(),
  chooseFile: vi.fn(),
  probeRuntime: vi.fn(),
  storageInfo: vi.fn(),
  listSystemFonts: vi.fn(async () => []),
}))

const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language')
function browserLanguage(language: string) {
  Object.defineProperty(navigator, 'language', { configurable: true, value: language })
}
beforeEach(() => {
  localStorage.clear()
  browserLanguage('en-US')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  if (originalLanguage) Object.defineProperty(navigator, 'language', originalLanguage)
  else Reflect.deleteProperty(navigator, 'language')
})

const settings: Settings = {
  runtimes: [{ id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: false, args: [], defaultModel: '', description: '' }],
  models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '', outputLimit: 65536,
}

function discovery(): LocalDiscoveryReport {
  return {
    scannedAt: '2026-10-10T00:00:00Z',
    runtimes: [{
      id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex',
      probe: { found: true, path: '/usr/local/bin/codex', version: '', error: 'Runtime 检测未能完成' },
      models: [{ modelId: 'user/model', name: 'User model', source: 'config.toml / 当前 profile · models_cache.json / 缓存', selected: true }],
      configSources: ['/Users/example/café-config/config.toml'],
      warnings: ['配置不是有效 UTF-8：/Users/example/café-config/config.toml', '模型来自配置、缓存或 CLI 列表，尚未验证实际可调用性'],
    }],
  }
}

describe('native diagnostic presentation', () => {
  it('only translates known native text and keeps variable data and unknown output intact', () => {
    expect(localizeNativeDiagnostic('Runtime 检测未能完成', 'en')).toBe('Runtime detection could not complete.')
    expect(localizeNativeDiagnostic('配置不是有效 UTF-8：/tmp/café-config.toml', 'en')).toBe('Configuration is not valid UTF-8: /tmp/café-config.toml')
    expect(localizeNativeDiagnostic('TraeX 模型查询超时，尝试本机缓存', 'en')).toBe('The TraeX model query timed out; trying the local cache.')
    expect(localizeNativeDiagnostic('TraeX Profile audit 使用不同 provider，未合并其模型；请通过启动参数选择', 'en')).toContain('TraeX profile audit uses another provider')
    expect(localizeNativeDiagnostic('Unknown user error café', 'en')).toBe('Unknown user error café')
    expect(localizeNativeDiagnostic('toString', 'en')).toBe('toString')
    expect(localizeNativeDiagnostic('Runtime 检测未能完成', 'zh')).toBe('Runtime 检测未能完成')
    expect(localizeNativeModelSource('config.toml / 当前 profile · models_cache.json / 缓存', 'en')).toBe('config.toml / current profile · models_cache.json / cache')
    expect(localizeNativeModelSource('config.toml / 当前 profile · models_cache.json / 缓存', 'zh')).toBe('config.toml / 当前 profile · models_cache.json / 缓存')
  })

  it('maps structured native codes in both languages and covers every Rust code', () => {
    expect(localizeNativeDiagnostic('local_scan_failed', 'en')).toBe('The local scan could not complete. Please try again.')
    expect(localizeNativeDiagnostic('local_scan_failed', 'zh')).toBe('本机检测任务未能完成，请重试')
    expect(localizeNativeDiagnostic('Error: pi_query_timeout', 'en')).toBe('The Pi model query timed out.')
    expect(localizeNativeDiagnostic('config_invalid_utf8\u001f/tmp/café-config.toml', 'en')).toBe('Configuration is not valid UTF-8: /tmp/café-config.toml')
    expect(localizeNativeDiagnostic('config_invalid_utf8\u001f/tmp/café-config.toml', 'zh')).toBe('配置不是有效 UTF-8：/tmp/café-config.toml')
    expect(localizeNativeDiagnostic('trying_local_cache\u001ftraex_query_timeout', 'en')).toBe('The TraeX model query timed out; trying the local cache.')
    expect(localizeNativeDiagnostic('trying_local_cache\u001ftraex_query_timeout', 'zh')).toBe('TraeX 模型查询超时，尝试本机缓存')
    expect(localizeNativeDiagnostic('traex_profile_other_provider\u001faudit', 'en')).toContain('TraeX profile audit uses another provider')
    expect(localizeNativeDiagnostic('traex_profile_other_provider\u001faudit', 'zh')).toContain('TraeX Profile audit 使用不同 provider')
    expect(localizeNativeDiagnostic('runtime_model_format_unsupported', 'en')).toContain('runtime’s')
    expect(localizeNativeModelSource('codex_current_profile · codex_model_cache', 'en')).toBe('config.toml / current profile · models_cache.json / cache')
    expect(localizeNativeModelSource('codex_current_profile · codex_model_cache', 'zh')).toBe('config.toml / 当前 profile · models_cache.json / 缓存')
    expect(localizeNativeModelSource('codex_profile_model\u001fconfigured_profile', 'en')).toBe('config.toml / profiles.configured profile.model')
    expect(localizeNativeModelSource('codex_profile_model\u001fconfigured_profile', 'zh')).toBe('config.toml / profiles.已配置 profile.model')
    expect(localizeNativeModelSource('traex_model_cache\u001ftrae', 'zh')).toBe('models_cache.json / trae / 缓存')
    expect(localizeNativeModelSource('traex_profile_candidate\u001fwork', 'en')).toBe('work.traecli.toml / candidate (--profile work)')
    expect(localizeNativeModelSource('process_env\u001fANTHROPIC_MODEL', 'en')).toBe('Process environment / ANTHROPIC_MODEL')
    expect(localizeNativeModelSource('dsh_provider\u001fconfigured_provider', 'en')).toBe('settings.yaml / llm-pi-ai.providers.configured provider')
    const sources = [
      'src-tauri/src/diagnostics.rs',
      'src-tauri/src/lib.rs',
      'src-tauri/src/pi_query.rs',
      'src-tauri/src/traex_query.rs',
      'src-tauri/src/local_discovery.rs',
      'src-tauri/src/local_discovery/pi.rs',
      'src-tauri/src/local_discovery/traex.rs',
    ].map(path => readFileSync(path, 'utf8')).join('\n')
    const found = new Set([...sources.matchAll(/diagnostic(?:_with)?\("([a-z0-9_]+)"/g)].map(match => match[1]))
    const mapped = new Set([...nativeDiagnosticCodes, ...nativeDiagnosticDetailCodes, ...nativeSourceCodes, ...nativeSourceDetailCodes])
    expect([...found].sort()).toEqual([...mapped].sort())
    for (const code of nativeDiagnosticCodes) {
      expect(localizeNativeDiagnostic(code, 'en')).not.toBe(code)
      expect(localizeNativeDiagnostic(code, 'zh')).not.toBe(code)
    }
    for (const code of nativeDiagnosticDetailCodes) {
      const encoded = `${code}\u001fexample`
      expect(localizeNativeDiagnostic(encoded, 'en')).not.toContain(code)
      expect(localizeNativeDiagnostic(encoded, 'zh')).not.toContain(code)
    }
  })

  it('renders scan errors and warnings in English without changing the report', async () => {
    const report = discovery()
    const raw = structuredClone(report)
    render(<I18nProvider><SetupPage report={report} scanning={false} error="" busy={false} settings={settings} mode="first-run" onRescan={vi.fn()} onImport={vi.fn(async () => {})} onConfigure={vi.fn()} onLater={vi.fn(async () => {})} /></I18nProvider>)
    expect(await screen.findByText('Runtime detection could not complete.')).toBeTruthy()
    expect(screen.getByText('Configuration is not valid UTF-8: /Users/example/café-config/config.toml')).toBeTruthy()
    expect(screen.getByText('Models came from configuration, cache, or a CLI list. Their availability has not been verified.')).toBeTruthy()
    expect(screen.getByText('config.toml / current profile · models_cache.json / cache')).toBeTruthy()
    expect(screen.getByText('/Users/example/café-config/config.toml')).toBeTruthy()
    expect(screen.getByText('User model')).toBeTruthy()
    expect(report).toEqual(raw)
  })

  it('localizes a saved probe error and an English built-in description after switching to Chinese', async () => {
    const report = discovery()
    render(<I18nProvider><SettingsPage settings={{ ...settings, runtimes: [{ ...settings.runtimes[0], description: 'Uses local Codex CLI login and configuration; installation must be checked.' }] }} activeCount={0} onSave={vi.fn(async () => {})} onAppearanceChange={vi.fn(async () => {})} onBack={vi.fn()} onExport={vi.fn()} discoveryReport={report} /></I18nProvider>)
    expect(await screen.findByText('Runtime detection could not complete.')).toBeTruthy()
    cleanup()
    browserLanguage('zh-CN')
    render(<I18nProvider><SettingsPage settings={{ ...settings, runtimes: [{ ...settings.runtimes[0], description: 'Uses local Codex CLI login and configuration; installation must be checked.' }] }} activeCount={0} onSave={vi.fn(async () => {})} onAppearanceChange={vi.fn(async () => {})} onBack={vi.fn()} onExport={vi.fn()} /></I18nProvider>)
    fireEvent.click(await screen.findByRole('button', { name: '高级启动配置' }))
    expect((screen.getByLabelText('备注') as HTMLTextAreaElement).value).toBe('使用本机 Codex CLI 的登录与配置；安装状态需检测。')
  })
})
