// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import type { AppearancePatch } from './lib/appearance'
import type { AppState, Settings } from './lib/types'

const bridge = vi.hoisted(() => ({
  isDesktop: true, loadState: vi.fn(), saveState: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(),
  discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(),
  startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(),
}))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/Workbench', () => ({ Workbench: () => null }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}))
vi.mock('@/components/SettingsPage', () => ({
  default: function SettingsProbe({ settings, onSave, onAppearanceChange, appearanceSaving }: {
    settings: Settings
    onSave: (settings: Settings) => Promise<void>
    onAppearanceChange: (patch: AppearancePatch) => Promise<void>
    appearanceSaving?: boolean
  }) {
    const [runtimeResult, setRuntimeResult] = useState('idle')
    const [appearanceResult, setAppearanceResult] = useState('idle')
    const [fontResult, setFontResult] = useState('idle')
    return <>
      <output data-testid="current-theme">{settings.theme}</output>
      <output data-testid="current-font">{settings.fontFamily}</output>
      <output data-testid="current-runtime">{settings.runtimes[0].name}</output>
      <output data-testid="runtime-result">{runtimeResult}</output>
      <output data-testid="appearance-result">{appearanceResult}</output>
      <output data-testid="font-result">{fontResult}</output>
      <output data-testid="appearance-saving">{String(Boolean(appearanceSaving))}</output>
      <button onClick={() => {
        setAppearanceResult('pending')
        void onAppearanceChange({ theme: 'light' }).then(() => setAppearanceResult('saved'), () => setAppearanceResult('failed'))
      }}>选择浅色主题</button>
      <button onClick={() => {
        setFontResult('pending')
        void onAppearanceChange({ fontFamily: 'Menlo' }).then(() => setFontResult('saved'), () => setFontResult('failed'))
      }}>选择 Menlo 字体</button>
      <button onClick={() => {
        // A manual Runtime draft may predate the appearance selection.
        const stale = structuredClone(settings)
        stale.theme = 'dark'
        stale.runtimes[0].name = 'Edited Runtime'
        setRuntimeResult('pending')
        void onSave(stale).then(() => setRuntimeResult('saved'), () => setRuntimeResult('failed'))
      }}>保存旧 Runtime 草稿</button>
    </>
  },
}))

let stored: AppState
beforeEach(() => {
  vi.resetAllMocks()
  stored = createInitialState()
  stored.settings.theme = 'dark'
  stored.settings.language = 'zh'
  stored.tasks = []
  stored.activeTaskId = ''
  stored.onboarding = { version: 1, completedAt: '2026-10-10T00:00:00Z', outcome: 'configured' }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (state: AppState) => { stored = structuredClone(state) })
  bridge.onRuntimeEvent.mockResolvedValue(() => {})
  bridge.loadTraceEvents.mockResolvedValue([])
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-theme-preference')
  document.documentElement.style.removeProperty('color-scheme')
  document.documentElement.classList.remove('dark', 'theme-changing')
})

async function openSettings() {
  render(<App />)
  const settings = await screen.findByRole('button', { name: /^设置$/ })
  await waitFor(() => expect((settings as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(settings)
  await screen.findByRole('button', { name: '选择浅色主题' })
  expect(document.documentElement.dataset.theme).toBe('dark')
  bridge.saveState.mockClear()
}

function holdWrites() {
  const writes: { state: AppState; resolve: () => void; reject: (error: Error) => void }[] = []
  bridge.saveState.mockImplementation((state: AppState) => {
    const snapshot = structuredClone(state)
    return new Promise<void>((resolve, reject) => {
      writes.push({ state: snapshot, resolve: () => { stored = snapshot; resolve() }, reject })
    })
  })
  return writes
}

function expectLightTheme() {
  expect(screen.getByTestId('current-theme').textContent).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.colorScheme).toBe('light')
  expect(document.documentElement.classList.contains('dark')).toBe(false)
}

describe('App appearance persistence', () => {
  it('applies appearance immediately and keeps it when a later Runtime save submits an old theme', async () => {
    await openSettings()
    const writes = holdWrites()

    fireEvent.click(screen.getByRole('button', { name: '选择浅色主题' }))
    expectLightTheme()
    expect(screen.getByTestId('appearance-saving').textContent).toBe('true')
    expect(writes).toHaveLength(1)
    expect(writes[0].state.settings.theme).toBe('light')
    expect(stored.settings.theme).toBe('dark')

    await act(async () => writes[0].resolve())
    expect(screen.getByTestId('appearance-result').textContent).toBe('saved')
    expect(screen.getByTestId('appearance-saving').textContent).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '保存旧 Runtime 草稿' }))
    expectLightTheme()
    expect(screen.getByTestId('current-runtime').textContent).toBe('Edited Runtime')
    expect(writes).toHaveLength(2)
    expect(writes[1].state.settings.theme).toBe('light')
    expect(writes[1].state.settings.runtimes[0].name).toBe('Edited Runtime')

    await act(async () => writes[1].resolve())
    expect(screen.getByTestId('runtime-result').textContent).toBe('saved')
    expect(stored.settings.theme).toBe('light')
    expect(stored.settings.runtimes[0].name).toBe('Edited Runtime')
  })

  it('preserves a newer appearance through an older Runtime save failure and the queued rollback snapshot', async () => {
    await openSettings()
    const originalRuntimeName = stored.settings.runtimes[0].name
    const writes = holdWrites()

    fireEvent.click(screen.getByRole('button', { name: '保存旧 Runtime 草稿' }))
    expect(writes).toHaveLength(1)
    expect(writes[0].state.settings.theme).toBe('dark')
    fireEvent.click(screen.getByRole('button', { name: '选择浅色主题' }))
    expectLightTheme()
    // The real writer has one in-flight request; appearance waits in its latest-snapshot slot.
    expect(writes).toHaveLength(1)
    expect(screen.getByTestId('appearance-saving').textContent).toBe('true')

    await act(async () => writes[0].reject(new Error('Runtime save failed')))
    expectLightTheme()
    expect(screen.getByTestId('current-runtime').textContent).toBe(originalRuntimeName)
    expect(writes).toHaveLength(2)
    expect(writes[1].state.settings.theme).toBe('light')
    expect(screen.getByTestId('runtime-result').textContent).toBe('pending')

    await act(async () => writes[1].resolve())
    expect(writes).toHaveLength(3)
    expect(writes[2].state.settings.theme).toBe('light')
    expect(writes[2].state.settings.runtimes[0].name).toBe(originalRuntimeName)
    expectLightTheme()

    await act(async () => writes[2].resolve())
    expect(screen.getByTestId('runtime-result').textContent).toBe('failed')
    expect(screen.getByTestId('appearance-result').textContent).toBe('saved')
    expect(screen.getByTestId('appearance-saving').textContent).toBe('false')
    expect(stored.settings.theme).toBe('light')
    expect(stored.settings.runtimes[0].name).toBe(originalRuntimeName)
    expectLightTheme()
  })

  it('rolls back a failed theme while a queued font save succeeds through the real persistence queue', async () => {
    await openSettings()
    const confirmedTheme = stored.settings.theme
    const writes = holdWrites()

    fireEvent.click(screen.getByRole('button', { name: '选择浅色主题' }))
    expectLightTheme()
    fireEvent.click(screen.getByRole('button', { name: '选择 Menlo 字体' }))
    expect(screen.getByTestId('current-font').textContent).toBe('Menlo')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toContain('Menlo')
    expect(writes).toHaveLength(1)
    expect(writes[0].state.settings.theme).toBe('light')
    expect(writes[0].state.settings.fontFamily).toBeUndefined()

    await act(async () => writes[0].reject(new Error('Theme save failed')))
    expect(writes).toHaveLength(2)
    expect(writes[1].state.settings).toMatchObject({ theme: 'light', fontFamily: 'Menlo' })
    expect(screen.getByTestId('current-theme').textContent).toBe(confirmedTheme)
    expect(document.documentElement.dataset.theme).toBe(confirmedTheme)
    expect(screen.getByTestId('current-font').textContent).toBe('Menlo')
    expect(screen.getByTestId('appearance-result').textContent).toBe('pending')
    expect(screen.getByTestId('font-result').textContent).toBe('pending')

    await act(async () => writes[1].resolve())
    expect(screen.getByTestId('font-result').textContent).toBe('saved')
    expect(screen.getByTestId('appearance-result').textContent).toBe('pending')
    expect(writes).toHaveLength(3)
    expect(writes[2].state.settings).toMatchObject({ theme: confirmedTheme, fontFamily: 'Menlo' })

    await act(async () => writes[2].resolve())
    expect(screen.getByTestId('appearance-result').textContent).toBe('failed')
    expect(screen.getByTestId('font-result').textContent).toBe('saved')
    expect(screen.getByTestId('appearance-saving').textContent).toBe('false')
    expect(stored.settings).toMatchObject({ theme: confirmedTheme, fontFamily: 'Menlo' })
    expect(screen.getByTestId('current-theme').textContent).toBe(stored.settings.theme)
    expect(screen.getByTestId('current-font').textContent).toBe(stored.settings.fontFamily)
    expect(document.documentElement.dataset.theme).toBe(stored.settings.theme)
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toContain(stored.settings.fontFamily)
  })
})
