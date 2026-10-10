// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppearancePatch } from '@/lib/appearance'
import type { AppState } from '@/lib/types'
import { useAppearanceSettings } from './use-appearance-settings'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function storedState(): AppState {
  const runtime = { id: 'runtime-1', name: 'Local Runtime', executable: 'runtime', adapter: 'generic' as const, enabled: true, args: ['--saved'], defaultModel: 'model-1', description: '' }
  return {
    version: 2, goals: [], agents: [], activeTaskId: 'task-1',
    settings: {
      runtimes: [runtime], models: [], providers: [], defaultRuntime: runtime.id,
      defaultMode: 'solo', maxParallel: 3, defaultDirectory: '/saved/project',
      theme: 'system', fontFamily: 'Inter', language: 'zh',
    },
    tasks: [{ id: 'task-1', title: 'Existing task', directory: '/saved/project', mode: 'solo', members: [], messages: [], runs: [], events: [], createdAt: '2026-10-10T00:00:00Z' }],
  }
}

/** Like useAppState.update: the updater sees the latest state synchronously;
 * persistence is deferred, and unchanged state does not produce a write. */
function deferredStore(initial = storedState()) {
  let current = initial
  let onChange: (state: AppState) => void = () => {}
  const writes: (ReturnType<typeof deferred> & { state: AppState })[] = []
  const update = vi.fn((change: (state: AppState) => AppState): Promise<void> => {
    const next = change(current)
    if (next === current) return Promise.resolve()
    current = next
    onChange(next)
    const write = { ...deferred(), state: next }
    writes.push(write)
    return write.promise
  })
  return {
    update, writes,
    get state() { return current },
    listen(listener: (state: AppState) => void) { onChange = listener },
    // Represents a newly committed configuration or a streaming state update.
    replace(change: (state: AppState) => AppState) { current = change(current); onChange(current) },
  }
}

type Store = ReturnType<typeof deferredStore>
function mount(store: Store) {
  return renderHook(() => {
    const [state, setState] = useState(store.state)
    store.listen(setState)
    return { ...useAppearanceSettings(state.settings, store.update), state }
  })
}

type Hook = ReturnType<typeof mount>
function choose(hook: Hook, patch: AppearancePatch) {
  let promise!: Promise<void>
  act(() => { promise = hook.result.current.saveAppearance(patch) })
  // Attach a rejection handler before deliberately rejecting a deferred write.
  return promise.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
}

async function succeed(store: Store, index: number) {
  await act(async () => { store.writes[index].resolve() })
}
async function fail(store: Store, index: number, error = new Error('Could not save appearance')) {
  await act(async () => { store.writes[index].reject(error) })
  return error
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('immediate appearance persistence', () => {
  it('updates the selected appearance before its persistence promise completes', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const saved = choose(hook, { theme: 'light' })
    expect(hook.result.current.state.settings.theme).toBe('light')
    expect(hook.result.current.appearanceSaving).toBe(true)
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].state.settings.theme).toBe('light')
    await succeed(store, 0)
    expect(await saved).toEqual({ ok: true })
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it('resolves an unchanged field independently of another field whose write is still pending', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const theme = choose(hook, { theme: 'light' })
    const unchangedFont = choose(hook, { fontFamily: 'Inter' })
    let noChangeOutcome: Awaited<typeof unchangedFont> | undefined
    void unchangedFont.then(outcome => { noChangeOutcome = outcome })
    await act(async () => {})
    expect(noChangeOutcome).toEqual({ ok: true })
    expect(store.writes).toHaveLength(1)
    expect(hook.result.current.appearanceSaving).toBe(true)

    const error = await fail(store, 0)
    await succeed(store, 1)
    expect(await theme).toEqual({ ok: false, error })
    expect(await unchangedFont).toEqual({ ok: true })
    expect(store.state.settings.fontFamily).toBe('Inter')
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it('merges an appearance patch into current state and preserves runtime configuration and live tasks on rollback', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const original = store.state
    const saved = choose(hook, { theme: 'light' })
    expect(store.state.settings.maxParallel).toBe(3)
    expect(store.state.settings.defaultDirectory).toBe('/saved/project')
    expect(store.state.settings.runtimes).toBe(original.settings.runtimes)
    expect(store.state.tasks).toBe(original.tasks)

    act(() => store.replace(state => ({
      ...state,
      settings: { ...state.settings, maxParallel: 5, runtimes: state.settings.runtimes.map(runtime => ({ ...runtime, args: ['--newly-saved'] })) },
      tasks: state.tasks.map(task => ({ ...task, messages: [{ id: 'stream-1', role: 'assistant', text: 'New output', streaming: true, createdAt: '2026-10-10T00:00:01Z' }] })),
    })))
    const latest = store.state
    const error = await fail(store, 0)
    expect(store.state.settings.theme).toBe('system')
    expect(store.state.settings.maxParallel).toBe(5)
    expect(store.state.settings.runtimes).toBe(latest.settings.runtimes)
    expect(store.state.tasks).toBe(latest.tasks)
    expect(store.writes[1].state.tasks[0].messages[0].text).toBe('New output')
    await succeed(store, 1)
    expect(await saved).toEqual({ ok: false, error })
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it('keeps a newer selection when an older selection fails', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const older = choose(hook, { theme: 'light' })
    const newer = choose(hook, { theme: 'dark' })
    const error = await fail(store, 0)
    expect(await older).toEqual({ ok: false, error })
    expect(store.state.settings.theme).toBe('dark')
    expect(store.writes).toHaveLength(2)
    expect(hook.result.current.appearanceSaving).toBe(true)
    await succeed(store, 1)
    expect(await newer).toEqual({ ok: true })
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it.each(['older-first', 'newer-first'] as const)('restores the confirmed preference when every selection fails (%s)', async order => {
    const store = deferredStore()
    const hook = mount(store)
    const older = choose(hook, { theme: 'light' })
    const newer = choose(hook, { theme: 'dark' })
    await fail(store, order === 'older-first' ? 0 : 1)
    await fail(store, order === 'older-first' ? 1 : 0)
    expect(store.state.settings.theme).toBe('system')
    expect(store.writes).toHaveLength(3)
    await succeed(store, 2)
    expect((await older).ok).toBe(false)
    expect((await newer).ok).toBe(false)
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it('rolls back to the newest successful choice even when an older success completes later', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const older = choose(hook, { theme: 'light' })
    const newer = choose(hook, { theme: 'dark' })
    await succeed(store, 1)
    await succeed(store, 0)
    expect((await older).ok).toBe(true)
    expect((await newer).ok).toBe(true)

    const failed = choose(hook, { theme: 'system' })
    const error = await fail(store, 2)
    expect(store.state.settings.theme).toBe('dark')
    await succeed(store, 3)
    expect(await failed).toEqual({ ok: false, error })
  })

  it.each(['fontFamily', 'theme'] as const)('rolls back only the failed %s field when another field saves concurrently', async failedKey => {
    const store = deferredStore()
    const hook = mount(store)
    const font = choose(hook, { fontFamily: 'Menlo' })
    const theme = choose(hook, { theme: 'light' })
    await succeed(store, failedKey === 'fontFamily' ? 1 : 0)
    await fail(store, failedKey === 'fontFamily' ? 0 : 1)
    expect(store.state.settings.fontFamily).toBe(failedKey === 'fontFamily' ? 'Inter' : 'Menlo')
    expect(store.state.settings.theme).toBe(failedKey === 'theme' ? 'system' : 'light')
    expect(store.state.settings.language).toBe('zh')
    await succeed(store, 2)
    expect((await font).ok).toBe(failedKey !== 'fontFamily')
    expect((await theme).ok).toBe(failedKey !== 'theme')
    expect(hook.result.current.appearanceSaving).toBe(false)
  })

  it('persists an explicit undefined language to clear a manual language override', async () => {
    const store = deferredStore()
    const hook = mount(store)
    const saved = choose(hook, { language: undefined })
    expect(store.state.settings.language).toBeUndefined()
    expect(store.state.settings.theme).toBe('system')
    expect(store.state.settings.fontFamily).toBe('Inter')
    expect(JSON.parse(JSON.stringify(store.writes[0].state)).settings).not.toHaveProperty('language')
    await succeed(store, 0)
    expect(await saved).toEqual({ ok: true })
  })

  it('finishes an App-owned write after the Settings child unmounts', async () => {
    const store = deferredStore()
    let appearance!: ReturnType<typeof useAppearanceSettings>
    const settingsUnmounted = vi.fn()
    function SettingsChild() {
      useEffect(() => settingsUnmounted, [])
      return <div>Appearance settings</div>
    }
    function AppHarness({ settingsOpen }: { settingsOpen: boolean }) {
      const [state, setState] = useState(store.state)
      store.listen(setState)
      appearance = useAppearanceSettings(state.settings, store.update)
      return settingsOpen ? <SettingsChild /> : <div>Workbench</div>
    }
    const app = render(<AppHarness settingsOpen />)
    let pending!: Promise<void>
    act(() => { pending = appearance.saveAppearance({ fontFamily: 'Menlo' }) })
    expect(appearance.appearanceSaving).toBe(true)
    app.rerender(<AppHarness settingsOpen={false} />)
    expect(settingsUnmounted).toHaveBeenCalledTimes(1)
    expect(store.state.settings.fontFamily).toBe('Menlo')
    await act(async () => { store.writes[0].resolve(); await pending })
    expect(appearance.appearanceSaving).toBe(false)
    expect(store.state.settings.fontFamily).toBe('Menlo')
    expect(store.writes).toHaveLength(1)
  })
})
