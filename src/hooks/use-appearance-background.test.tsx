// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppBackground } from '@/components/AppBackground'
import { loadBackgroundImage } from '@/lib/background-image'
import type { Settings } from '@/lib/types'
import * as i18n from '@/i18n'
import { useAppearanceBackground } from './use-appearance-background'

vi.mock('@/lib/background-image', () => ({ loadBackgroundImage: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const decodes: (ReturnType<typeof deferred<void>> & { src: string })[] = []
const revoked = vi.fn()
type BackgroundSettings = Pick<Settings, 'backgroundImage' | 'backgroundImageOpacity' | 'backgroundSurfaceOpacity'>
function selected(path?: string, extra: Partial<BackgroundSettings> = {}): BackgroundSettings {
  return { backgroundImage: path ? { path, name: `${path}.png` } : undefined, ...extra }
}
function mount(settings = selected()) {
  return renderHook(({ value }) => useAppearanceBackground(value), { initialProps: { value: settings } })
}
async function decode(index: number) {
  await act(async () => { decodes[index].resolve() })
}

beforeEach(() => {
  decodes.length = 0
  vi.mocked(loadBackgroundImage).mockReset()
  revoked.mockReset()
  vi.stubGlobal('Image', class {
    src = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    decode() { const request = { ...deferred<void>(), src: this.src }; decodes.push(request); return request.promise }
  })
  vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoked })
})

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('global appearance background lifecycle', () => {
  it('retains the opaque app when no image is selected and renders no decorative element', () => {
    const hook = mount()
    expect(hook.result.current).toMatchObject({ src: undefined, loading: false, error: undefined })
    expect(loadBackgroundImage).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--app-background-image-opacity')).toBe('100%')
    expect(document.documentElement.style.getPropertyValue('--app-surface-opacity')).toBe('85%')
    const { container } = render(<AppBackground />)
    expect(container.children).toHaveLength(0)
  })

  it('activates image and surface opacity only after bytes have decoded, without applying foreground opacity', async () => {
    vi.mocked(loadBackgroundImage).mockResolvedValue('blob:first')
    const hook = mount(selected('first', { backgroundImageOpacity: 70, backgroundSurfaceOpacity: 60 }))
    await act(async () => {})
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.src).toBeUndefined()
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(decodes[0].src).toBe('blob:first')
    await decode(0)
    expect(hook.result.current).toMatchObject({ src: 'blob:first', loading: false })
    expect(document.documentElement.dataset.appBackground).toBe('ready')
    expect(document.documentElement.style.getPropertyValue('--app-background-image-opacity')).toBe('70%')
    expect(document.documentElement.style.getPropertyValue('--app-surface-opacity')).toBe('60%')
    expect(document.documentElement.style.opacity).toBe('')
    const { container } = render(<AppBackground src={hook.result.current.src} />)
    expect(container.querySelector('.app-background')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first')
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('clears a stale image immediately on replacement and retains the selected reference after a loading failure', async () => {
    vi.mocked(loadBackgroundImage).mockResolvedValueOnce('blob:first').mockRejectedValueOnce(new Error('File is missing'))
    const hook = mount(selected('first'))
    await act(async () => {})
    await decode(0)
    const missing = selected('missing')
    hook.rerender({ value: missing })
    expect(hook.result.current.src).toBeUndefined()
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(revoked).toHaveBeenCalledWith('blob:first')
    await act(async () => {})
    expect(hook.result.current).toMatchObject({ loading: false, error: 'File is missing' })
    expect(missing.backgroundImage?.path).toBe('missing')
  })

  it('ignores and releases a superseded read success without disturbing the newest image', async () => {
    const first = deferred<string>()
    vi.mocked(loadBackgroundImage).mockReturnValueOnce(first.promise).mockResolvedValueOnce('blob:newest')
    const hook = mount(selected('first'))
    hook.rerender({ value: selected('newest') })
    await act(async () => {})
    await decode(0)
    await act(async () => { first.resolve('blob:stale') })
    expect(revoked).toHaveBeenCalledWith('blob:stale')
    expect(decodes).toHaveLength(1)
    expect(hook.result.current).toMatchObject({ src: 'blob:newest', error: undefined, loading: false })
  })

  it('ignores superseded failures and revokes a decoded source when removal interrupts decoding', async () => {
    const first = deferred<string>()
    vi.mocked(loadBackgroundImage).mockReturnValueOnce(first.promise).mockResolvedValueOnce('blob:second')
    const hook = mount(selected('first'))
    hook.rerender({ value: selected('second') })
    await act(async () => {})
    await act(async () => { first.reject(new Error('Stale file error')) })
    expect(hook.result.current.error).toBeUndefined()
    hook.rerender({ value: selected() })
    await act(async () => { decodes[0].reject(new Error('Interrupted decode')) })
    expect(hook.result.current).toMatchObject({ src: undefined, error: undefined, loading: false })
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(revoked.mock.calls).toEqual([['blob:second']])
  })

  it('releases an undecodable image and retries the persisted reference', async () => {
    vi.mocked(loadBackgroundImage).mockResolvedValueOnce('blob:bad').mockResolvedValueOnce('blob:retried')
    const hook = mount(selected('first'))
    await act(async () => {})
    await act(async () => { decodes[0].reject(new Error('Decode failure')) })
    expect(hook.result.current.error).toContain('无法解码')
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(revoked).toHaveBeenCalledWith('blob:bad')
    act(() => hook.result.current.retry())
    expect(hook.result.current.loading).toBe(true)
    expect(hook.result.current.error).toBeUndefined()
    await act(async () => {})
    await decode(1)
    expect(hook.result.current).toMatchObject({ src: 'blob:retried', loading: false, error: undefined })
    expect(loadBackgroundImage).toHaveBeenNthCalledWith(2, { path: 'first', name: 'first.png' })
  })

  it('uses the current language for a decode error', async () => {
    vi.spyOn(i18n, 'translate').mockImplementation((_zh, en) => en)
    vi.mocked(loadBackgroundImage).mockResolvedValue('blob:bad')
    const hook = mount(selected('first'))
    await act(async () => {})
    await act(async () => { decodes[0].reject(new Error('Decode failure')) })
    expect(hook.result.current.error).toBe('Background image could not be decoded. Choose another image or retry.')
    expect(revoked).toHaveBeenCalledWith('blob:bad')
  })

  it('tracks opacity edits immediately without rereading pixels and cleans document state on unmount', async () => {
    vi.mocked(loadBackgroundImage).mockResolvedValue('blob:current')
    const hook = mount(selected('first'))
    await act(async () => {})
    await decode(0)
    vi.useFakeTimers()
    document.documentElement.classList.add('theme-changing')
    hook.rerender({ value: selected('first', { backgroundImageOpacity: -8, backgroundSurfaceOpacity: 120 }) })
    expect(document.documentElement.style.getPropertyValue('--app-background-image-opacity')).toBe('0%')
    expect(document.documentElement.style.getPropertyValue('--app-surface-opacity')).toBe('100%')
    expect(document.documentElement.classList.contains('background-adjusting')).toBe(true)
    expect(loadBackgroundImage).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(250))
    expect(document.documentElement.classList.contains('background-adjusting')).toBe(false)
    hook.unmount()
    expect(revoked).toHaveBeenCalledWith('blob:current')
    expect(document.documentElement.dataset.appBackground).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--app-surface-opacity')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-background-image-opacity')).toBe('')
    document.documentElement.classList.remove('theme-changing')
  })
})
