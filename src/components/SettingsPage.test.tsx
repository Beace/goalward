// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage, type SettingsPageProps } from './SettingsPage'
import { I18nProvider, useI18n } from '@/i18n'
import type { LocalDiscoveryReport, Settings, ThemePreference } from '@/lib/types'

const bridge = vi.hoisted(() => ({
  isDesktop: true,
  chooseDirectory: vi.fn(),
  chooseFile: vi.fn(),
  probeRuntime: vi.fn(),
  storageInfo: vi.fn(),
  listSystemFonts: vi.fn(),
}))
vi.mock('@/lib/bridge', () => bridge)

function settings(): Settings {
  return {
    runtimes: [
      { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: false, args: [], defaultModel: '', description: '' },
      { id: 'claude', name: 'Claude Code', executable: 'claude', adapter: 'claude', enabled: false, args: [], defaultModel: '', description: '' },
    ],
    models: [], providers: [], defaultRuntime: '', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '', outputLimit: 65536,
  }
}
type AppearancePatch = Parameters<SettingsPageProps['onAppearanceChange']>[0]
function callbacksForSettings() {
  return { onSave: vi.fn(async (_settings: Settings) => undefined), onAppearanceChange: vi.fn(async (_patch: AppearancePatch) => undefined), onBack: vi.fn(), onExport: vi.fn(), onDiscover: vi.fn() }
}
function mount(props: Partial<SettingsPageProps> = {}) {
  const callbacks = callbacksForSettings()
  render(<SettingsPage settings={settings()} activeCount={0} {...callbacks} {...props} />)
  return callbacks
}

/** A parent owns saved appearance; settings drafts remain inside the actual page. */
function mountControlled(initial = settings(), props: Partial<SettingsPageProps> = {}, i18n = false) {
  const callbacks = callbacksForSettings()
  let currentSettings = initial
  function Harness() {
    const [current, setCurrent] = useState(initial)
    const { setPreference } = useI18n()
    useEffect(() => { setPreference(current.language ?? 'system') }, [current.language, setPreference])
    async function changeAppearance(patch: AppearancePatch) {
      const request = callbacks.onAppearanceChange(patch)
      setCurrent(previous => { currentSettings = { ...previous, ...patch }; return currentSettings })
      await request
    }
    async function save(next: Settings) {
      await callbacks.onSave(next)
      currentSettings = next
      setCurrent(next)
    }
    return <SettingsPage settings={current} activeCount={0} {...callbacks} {...props} onSave={save} onAppearanceChange={changeAppearance} />
  }
  const view = render(i18n ? <I18nProvider><Harness /></I18nProvider> : <Harness />)
  return { ...callbacks, ...view, currentSettings: () => currentSettings }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' })
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {}; unobserve() {}; disconnect() {} })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function selectOption(label: string, optionName: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' })
  const option = await screen.findByRole('option', { name: optionName })
  option.focus()
  fireEvent.keyDown(option, { key: 'Enter' })
}

describe('SettingsPage discovery entry', () => {
  it('opens the requested initial category and runtime without changing saved settings', () => {
    const callbacks = mount({ initialCategory: 'models', initialRuntimeId: 'claude', setupHint: true })
    expect(screen.getByRole('heading', { name: '模型与供应商' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '配置运行时' }))
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy()
    expect((screen.getByLabelText('可执行文件') as HTMLInputElement).value).toBe('claude')
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('preserves unsaved edits when discovery is cancelled, and discards them only on explicit confirmation', () => {
    const callbacks = mount()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Edited Codex' } })
    fireEvent.click(screen.getByRole('button', { name: '自动检测本机' }))
    expect(screen.getByRole('dialog', { name: '放弃未保存的更改？' })).toBeTruthy()
    expect(callbacks.onDiscover).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Edited Codex')
    fireEvent.click(screen.getByRole('button', { name: '自动检测本机' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃更改并检测' }))
    expect(callbacks.onDiscover).toHaveBeenCalledOnce()
    expect(callbacks.onBack).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Codex')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('enters discovery directly from an unchanged form', () => {
    const callbacks = mount()
    fireEvent.click(screen.getByRole('button', { name: '自动检测本机' }))
    expect(callbacks.onDiscover).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('invalidates historical discovery when the path changes, then displays a fresh probe result', async () => {
    const discoveryReport: LocalDiscoveryReport = {
      scannedAt: '2026-09-15T01:00:00Z',
      runtimes: [{ id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', probe: { found: true, path: '/old/bin/codex', version: 'old version' }, models: [], configSources: [], warnings: [] }],
    }
    mount({ discoveryReport })
    expect(screen.getByText('上次已找到可执行文件')).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(discoveryReport.scannedAt)
    fireEvent.change(screen.getByLabelText('可执行文件'), { target: { value: '/new/bin/codex' } })
    expect(screen.queryByText('上次已找到可执行文件')).toBeNull()
    expect(screen.queryByText(/old version/)).toBeNull()
    expect(screen.getByText('尚未检测')).toBeTruthy()
    bridge.probeRuntime.mockResolvedValue({ found: true, path: '/new/bin/codex', version: 'new version' })
    fireEvent.click(screen.getByRole('button', { name: '检测可执行文件' }))
    await waitFor(() => expect(screen.getByText('已找到可执行文件')).toBeTruthy())
    expect(bridge.probeRuntime).toHaveBeenCalledWith('/new/bin/codex')
    expect(screen.getByText(/new version/)).toBeTruthy()
    expect(screen.queryByText(/上次检测：/)).toBeNull()
  })
})

describe('Runtime access permissions', () => {
  it('preserves inherited settings until edited and does not materialize defaults during unrelated saves', async () => {
    const callbacks = mount()
    expect(screen.getByRole('heading', { name: '访问权限' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '访问权限' }))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    expect(screen.getByRole('combobox', { name: '文件访问范围' }).textContent).toBe('完整访问（关闭 Codex 沙箱）')
    expect((screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Local Codex' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].runtimes[0].permissions).toBeUndefined()
  })

  it('saves workspace permissions and resets incompatible grants when changing to read-only', async () => {
    const callbacks = mount()
    await selectOption('文件访问范围', '任务目录可写')
    await selectOption('沙箱命令联网', '允许网络访问')
    fireEvent.change(screen.getByLabelText('额外可写目录'), { target: { value: '/tmp/notes\n/Users/shared' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].runtimes[0].permissions?.codex).toEqual({ sandbox: 'workspace-write', network: 'allow', additionalDirectories: ['/tmp/notes', '/Users/shared'] })
    await selectOption('文件访问范围', '只读')
    expect(screen.queryByLabelText('额外可写目录')).toBeNull()
    expect((screen.getByRole('combobox', { name: '沙箱命令联网' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledTimes(2))
    expect(callbacks.onSave.mock.calls[1][0].runtimes[0].permissions?.codex).toEqual({ sandbox: 'read-only', network: 'inherit', additionalDirectories: [] })
  })

  it('keeps relative paths and conflicting startup flags from being saved', async () => {
    const initial = settings()
    initial.runtimes[0].args = ['--full-auto']
    const callbacks = mount({ settings: initial })
    await selectOption('文件访问范围', '任务目录可写')
    fireEvent.change(screen.getByLabelText('额外可写目录'), { target: { value: './relative' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getAllByText(/额外目录需逐行填写绝对路径/).length).toBeGreaterThan(0)
    expect(callbacks.onSave).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('额外可写目录'), { target: { value: '/tmp/valid' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    expect(screen.getAllByText(/--full-auto.*会覆盖访问权限/).length).toBeGreaterThan(0)
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('retains invalid generic JSON across runtime switching and protects it when leaving', async () => {
    const initial = settings()
    initial.runtimes.push({ id: 'custom', name: 'Custom CLI', executable: 'custom', adapter: 'generic', enabled: false, args: [], defaultModel: '', description: '' })
    const callbacks = mount({ settings: initial, initialRuntimeId: 'custom' })
    fireEvent.change(screen.getByLabelText('权限参数 JSON'), { target: { value: '["--sandbox",' } })
    fireEvent.click(screen.getByRole('button', { name: /^Codex\s*已停用/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Custom CLI\s*已停用/ }))
    expect((screen.getByLabelText('权限参数 JSON') as HTMLTextAreaElement).value).toBe('["--sandbox",')
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    expect(callbacks.onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }))
    expect(screen.getByRole('dialog', { name: '放弃未保存的更改？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    fireEvent.change(screen.getByLabelText('权限参数 JSON'), { target: { value: '["--sandbox", "read-only"]' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].runtimes[2].permissions?.generic?.args).toEqual(['--sandbox', 'read-only'])
  })

  it('preserves independent Claude rules and adds an absolute directory from the picker', async () => {
    const callbacks = mount({ initialRuntimeId: 'claude' })
    await selectOption('工具审批模式', '自动批准文件编辑')
    fireEvent.change(screen.getByLabelText('自动允许的工具'), { target: { value: 'Read\nBash(git status)\n' } })
    fireEvent.change(screen.getByLabelText('禁止的工具'), { target: { value: 'WebFetch\nBash(rm *)' } })
    bridge.chooseDirectory.mockResolvedValue('/tmp/shared docs')
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    await waitFor(() => expect((screen.getByLabelText('额外工作目录') as HTMLTextAreaElement).value).toBe('/tmp/shared docs'))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].runtimes[1].permissions?.claude).toEqual({ mode: 'acceptEdits', additionalDirectories: ['/tmp/shared docs'], allowedTools: ['Read', 'Bash(git status)'], disallowedTools: ['WebFetch', 'Bash(rm *)'] })
    expect(callbacks.onSave.mock.calls[0][0].runtimes[0].permissions).toBeUndefined()
  })

  it('renders malformed saved permissions as a recoverable form error', () => {
    const initial = settings()
    initial.runtimes[0].permissions = { codex: { sandbox: 'workspace-write', network: 'inherit', additionalDirectories: null } } as unknown as Settings['runtimes'][number]['permissions']
    mount({ settings: initial })
    expect(screen.getByRole('heading', { name: '访问权限' })).toBeTruthy()
    expect(screen.getByText(/额外目录需逐行填写绝对路径/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('额外可写目录'), { target: { value: '/tmp/recovered' } })
    expect(screen.queryByText(/额外目录需逐行填写绝对路径/)).toBeNull()
  })
})

describe('model reasoning defaults', () => {
  it('offers only discovered Kimi efforts and saves an explicit model preference', async () => {
    const initial = settings()
    initial.runtimes.push({ id: 'kimi', name: 'Kimi CLI', executable: 'kimi', adapter: 'kimi', enabled: true, args: [], defaultModel: '', description: '' })
    initial.models.push({ id: 'k3', name: 'K3', modelId: 'kimi-code/k3', runtimeIds: ['kimi'], providerId: '', enabled: true, supportedReasoningEffortsByRuntime: { kimi: ['low', 'high', 'max'] } })
    const callbacks = mount({ settings: initial, initialCategory: 'models' })
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 K3' }))
    fireEvent.keyDown(screen.getByRole('combobox', { name: '模型默认思考强度' }), { key: 'Enter' })
    expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Runtime 默认', '低 · low', '高 · high', '最高 · max'])
    const max = screen.getByRole('option', { name: '最高 · max' })
    max.focus(); fireEvent.keyDown(max, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].models[0]).toMatchObject({ reasoningEffort: 'max', supportedReasoningEffortsByRuntime: { kimi: ['low', 'high', 'max'] } })
    expect(callbacks.onSave.mock.calls[0][0].runtimes).toEqual(initial.runtimes)
  })
  function withModel() {
    const initial = settings()
    initial.models.push({ id: 'astra', name: 'Astra', modelId: 'gpt-6-astra', providerId: '', runtimeIds: ['codex'], enabled: true })
    return initial
  }

  it('saves a model default separately from Runtime configuration and explains ultra delegation', async () => {
    const callbacks = mount({ settings: withModel(), initialCategory: 'models' })
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 Astra' }))
    expect(screen.getByRole('combobox', { name: '模型默认思考强度' }).textContent).toBe('Runtime 默认')
    await selectOption('模型默认思考强度', '极高 · ultra')
    expect(screen.getByText('ultra 可由 Codex 自动委派子任务。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].models[0].reasoningEffort).toBe('ultra')
    expect(callbacks.onSave.mock.calls[0][0].runtimes[0].permissions).toBeUndefined()
    expect(screen.getByText('思考：极高 · ultra')).toBeTruthy()
  })

  it('keeps old model defaults absent when applying an unrelated model edit', async () => {
    const callbacks = mount({ settings: withModel(), initialCategory: 'models' })
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 Astra' }))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Astra renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].models[0].reasoningEffort).toBeUndefined()
  })

  it('rejects a default that no longer supports every compatible runtime', async () => {
    const initial = withModel()
    initial.runtimes.push({ id: 'custom', name: 'Custom CLI', executable: 'custom', adapter: 'generic', enabled: false, args: [], defaultModel: '', description: '' })
    const callbacks = mount({ settings: initial, initialCategory: 'models' })
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 Astra' }))
    await selectOption('模型默认思考强度', '高 · high')
    fireEvent.click(screen.getByRole('switch', { name: /Custom CLI/ }))
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    expect(screen.getByRole('alert').textContent).toMatch(/不适用于当前模型的全部兼容 Runtime/)
    expect(callbacks.onSave).not.toHaveBeenCalled()
    await selectOption('模型默认思考强度', 'Runtime 默认')
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].models[0].reasoningEffort).toBe('inherit')
  })

  it('drops discovery capabilities when the actual Model ID is edited', async () => {
    const initial = withModel()
    initial.models[0].supportedReasoningEfforts = ['high', 'ultra']
    initial.models[0].supportedReasoningEffortsByRuntime = { codex: ['high', 'ultra'] }
    initial.models[0].reasoningEffort = 'ultra'
    const callbacks = mount({ settings: initial, initialCategory: 'models' })
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 Astra' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'gpt-5.5' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    expect(screen.getByRole('alert').textContent).toMatch(/不适用于当前模型的全部兼容 Runtime/)
    await selectOption('模型默认思考强度', '高 · high')
    fireEvent.click(screen.getByRole('button', { name: '应用到配置' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0].models[0].supportedReasoningEfforts).toBeUndefined()
    expect(callbacks.onSave.mock.calls[0][0].models[0].supportedReasoningEffortsByRuntime).toBeUndefined()
  })
})


describe('SettingsPage appearance', () => {
  it('saves a manual English choice immediately and can return to following the system', async () => {
    bridge.listSystemFonts.mockResolvedValue([])
    const callbacks = mountControlled()
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect(screen.getByRole('combobox', { name: '界面语言' }).textContent).toBe('跟随系统')
    await selectOption('界面语言', 'English')
    await waitFor(() => expect(callbacks.onAppearanceChange).toHaveBeenCalledWith({ language: 'en' }))
    expect(callbacks.currentSettings().language).toBe('en')
    await selectOption('界面语言', '跟随系统')
    expect(callbacks.onAppearanceChange.mock.calls).toEqual([[{ language: 'en' }], [{ language: undefined }]])
    expect(callbacks.currentSettings().language).toBeUndefined()
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('displays unknown imported appearance preferences consistently with the system fallback', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const callbacks = mount({ settings: { ...settings(), theme: 'unknown' as ThemePreference } })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toBe('跟随系统')
    await screen.findByText('本机可用字体 · 1 款')
    expect(screen.queryByRole('button', { name: '保存更改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '还原' })).toBeNull()
    expect(callbacks.onAppearanceChange).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('defaults legacy settings to following the system without changing the saved configuration', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const callbacks = mount()
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toBe('跟随系统')
    await screen.findByText('本机可用字体 · 1 款')
    expect(callbacks.onAppearanceChange).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it.each([
    ['dark', '浅色', 'light'],
    ['light', '深色', 'dark'],
    ['light', '跟随系统', 'system'],
  ] as [ThemePreference, string, ThemePreference][])('applies and saves a theme change from %s to %s immediately', async (previous, option, theme) => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const callbacks = mountControlled({ ...settings(), theme: previous })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await selectOption('界面主题', option)
    expect(callbacks.onAppearanceChange.mock.calls).toEqual([[{ theme }]])
    expect(callbacks.currentSettings().theme).toBe(theme)
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toBe(option)
    expect(screen.queryByRole('button', { name: '保存更改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '还原' })).toBeNull()
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('applies a font immediately without submitting unrelated settings', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo', 'PingFang SC'])
    const callbacks = mountControlled()
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await screen.findByText('本机可用字体 · 2 款')
    fireEvent.click(screen.getByRole('combobox', { name: '界面字体' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Menlo' }))
    expect(callbacks.onAppearanceChange.mock.calls).toEqual([[{ fontFamily: 'Menlo' }]])
    expect(callbacks.currentSettings().fontFamily).toBe('Menlo')
    expect(screen.getByRole('combobox', { name: '界面字体' }).textContent).toContain('Menlo')
    expect(screen.getByTestId('font-preview').style.fontFamily).toContain('Menlo')
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('isolates invalid Runtime drafts and does not revert appearance when restoring the draft', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const callbacks = mountControlled({ ...settings(), theme: 'dark' })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await selectOption('界面主题', '浅色')
    expect(callbacks.onAppearanceChange).toHaveBeenCalledWith({ theme: 'light' })
    expect(callbacks.currentSettings().runtimes[0].name).toBe('Codex')
    expect(callbacks.onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '运行时' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '还原' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Codex')
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toBe('浅色')
    expect(callbacks.currentSettings().theme).toBe('light')
  })

  it('preserves the latest controlled appearance in a later manual Runtime save', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const callbacks = mountControlled({ ...settings(), theme: 'dark' })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Local Codex' } })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await selectOption('界面主题', '浅色')
    await selectOption('界面语言', 'English')
    fireEvent.click(screen.getByRole('button', { name: '运行时' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Local Codex')
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce())
    expect(callbacks.onSave.mock.calls[0][0]).toMatchObject({ theme: 'light', language: 'en' })
    expect(callbacks.onSave.mock.calls[0][0].runtimes[0].name).toBe('Local Codex')
  })

  it('allows leaving during an appearance save without an unsaved draft prompt', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    let finish!: () => void
    const onAppearanceChange = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const callbacks = mount({ settings: { ...settings(), theme: 'dark' }, onAppearanceChange, appearanceSaving: true })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await selectOption('界面主题', '浅色')
    expect(onAppearanceChange).toHaveBeenCalledWith({ theme: 'light' })
    expect((screen.getByRole('button', { name: '返回工作台' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }))
    expect(callbacks.onBack).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    finish()
  })

  it('reports appearance failures and retries the same patch while the parent retains its saved value', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo'])
    const onAppearanceChange = vi.fn<(patch: AppearancePatch) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Disk unavailable')).mockResolvedValueOnce(undefined)
    const callbacks = mount({ settings: { ...settings(), theme: 'dark' }, onAppearanceChange })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await selectOption('界面主题', '浅色')
    expect((await screen.findByRole('alert')).textContent).toContain('Disk unavailable')
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toBe('深色')
    expect(callbacks.onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() => expect(onAppearanceChange.mock.calls).toEqual([[{ theme: 'light' }], [{ theme: 'light' }]]))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps a saved missing font and reports fallback without silently rewriting it', async () => {
    bridge.listSystemFonts.mockResolvedValue(['Menlo', 'PingFang SC'])
    const callbacks = mount({ settings: { ...settings(), fontFamily: 'Uninstalled Font' } })
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await screen.findByText('本机未找到已选字体，将使用默认字体回退。')
    expect(screen.getByRole('combobox', { name: '界面字体' }).textContent).toContain('Uninstalled Font')
    expect(callbacks.onAppearanceChange).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '保存更改' })).toBeNull()
  })

  it('shows discovery failures and supports retry without altering saved settings', async () => {
    bridge.listSystemFonts.mockRejectedValueOnce(new Error('Font service unavailable')).mockResolvedValueOnce(['Menlo'])
    const callbacks = mount()
    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Font service unavailable')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('本机可用字体 · 1 款')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(callbacks.onAppearanceChange).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
  })

  it('renders English settings and applies a Chinese language choice without manual saving', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' })
    bridge.listSystemFonts.mockResolvedValue([])
    const callbacks = mountControlled(settings(), {}, true)
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Interface language' }).textContent).toBe('Follow system')
    expect(document.documentElement.lang).toBe('en')
    await selectOption('Interface language', '中文')
    await waitFor(() => expect(callbacks.onAppearanceChange).toHaveBeenCalledWith({ language: 'zh' }))
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: '外观' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('translates only a saved built-in runtime description for display', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' })
    const initial = settings()
    const savedDescription = '使用本机 Codex CLI 的登录与配置；安装状态需检测。'
    initial.runtimes[0].description = savedDescription
    initial.runtimes[1].description = 'My own Claude Code notes 中文'
    const onSave = vi.fn(async (_settings: Settings) => undefined)
    render(<I18nProvider><SettingsPage settings={initial} activeCount={0} onSave={onSave} onAppearanceChange={vi.fn(async () => undefined)} onBack={vi.fn()} onExport={vi.fn()} /></I18nProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced startup settings' }))
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Uses local Codex CLI login and configuration; installation must be checked.')
    fireEvent.click(screen.getByRole('button', { name: /^Claude Code\s*Disabled/ }))
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('My own Claude Code notes 中文')
    fireEvent.click(screen.getByRole('button', { name: /^Codex\s*Disabled/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local Codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0].runtimes[0].description).toBe(savedDescription)
    expect(onSave.mock.calls[0][0].runtimes[1].description).toBe('My own Claude Code notes 中文')
  })
})
