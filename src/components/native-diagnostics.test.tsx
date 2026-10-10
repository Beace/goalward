// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { localizeNativeDiagnostic, localizeNativeModelSource } from '@/lib/native-diagnostics'
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
      models: [{ modelId: 'user/model', name: '用户模型', source: 'config.toml / 当前 profile · models_cache.json / 缓存', selected: true }],
      configSources: ['/Users/example/中文配置/config.toml'],
      warnings: ['配置不是有效 UTF-8：/Users/example/中文配置/config.toml', '模型来自配置、缓存或 CLI 列表，尚未验证实际可调用性'],
    }],
  }
}

describe('native diagnostic presentation', () => {
  it('only translates known native text and keeps variable data and unknown output intact', () => {
    expect(localizeNativeDiagnostic('Runtime 检测未能完成', 'en')).toBe('Runtime detection could not complete.')
    expect(localizeNativeDiagnostic('配置不是有效 UTF-8：/tmp/中文配置.toml', 'en')).toBe('Configuration is not valid UTF-8: /tmp/中文配置.toml')
    expect(localizeNativeDiagnostic('TraeX 模型查询超时，尝试本机缓存', 'en')).toBe('The TraeX model query timed out; trying the local cache.')
    expect(localizeNativeDiagnostic('TraeX Profile audit 使用不同 provider，未合并其模型；请通过启动参数选择', 'en')).toContain('TraeX profile audit uses another provider')
    expect(localizeNativeDiagnostic('用户输入的中文错误', 'en')).toBe('用户输入的中文错误')
    expect(localizeNativeDiagnostic('toString', 'en')).toBe('toString')
    expect(localizeNativeDiagnostic('Runtime 检测未能完成', 'zh')).toBe('Runtime 检测未能完成')
    expect(localizeNativeModelSource('config.toml / 当前 profile · models_cache.json / 缓存', 'en')).toBe('config.toml / current profile · models_cache.json / cache')
  })

  it('renders scan errors and warnings in English without changing the report', async () => {
    const report = discovery()
    const raw = structuredClone(report)
    render(<I18nProvider><SetupPage report={report} scanning={false} error="" busy={false} settings={settings} mode="first-run" onRescan={vi.fn()} onImport={vi.fn(async () => {})} onConfigure={vi.fn()} onLater={vi.fn(async () => {})} /></I18nProvider>)
    expect(await screen.findByText('Runtime detection could not complete.')).toBeTruthy()
    expect(screen.getByText('Configuration is not valid UTF-8: /Users/example/中文配置/config.toml')).toBeTruthy()
    expect(screen.getByText('Models came from configuration, cache, or a CLI list. Their availability has not been verified.')).toBeTruthy()
    expect(screen.getByText('config.toml / current profile · models_cache.json / cache')).toBeTruthy()
    expect(screen.getByText('/Users/example/中文配置/config.toml')).toBeTruthy()
    expect(screen.getByText('用户模型')).toBeTruthy()
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
