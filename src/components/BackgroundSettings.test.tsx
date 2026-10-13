// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackgroundSettings, type BackgroundSettingsProps } from './BackgroundSettings'
import type { AppearancePatch } from '@/lib/appearance'
import type { AppBackgroundImage } from '@/lib/types'

const mock = vi.hoisted(() => ({ desktop: false, choose: vi.fn() }))
vi.mock('@/lib/bridge', () => ({ get isDesktop() { return mock.desktop } }))
vi.mock('@/lib/background-image', () => ({ chooseBackgroundImage: mock.choose, BACKGROUND_IMAGE_ACCEPT: '.png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.ico,.tif,.tiff,.heic,.heif' }))
const original = { name: 'original-background.png', path: '/app/background-images/original.png' }
const replacement = { name: 'replacement-background.png', path: '/app/background-images/replacement.png' }
const browserFile = new File(['image bytes'], 'background.png', { type: 'image/png' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function renderSettings(props: Partial<BackgroundSettingsProps> = {}) {
  const onChange = vi.fn()
  const view = render(<BackgroundSettings onChange={onChange} disabled={false} {...props} />)
  return { ...view, onChange }
}

beforeEach(() => {
  mock.desktop = false
  mock.choose.mockReset().mockResolvedValue(replacement)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens the browser file picker, shows real import progress, and applies only a decoded import', async () => {
  const pending = deferred<AppBackgroundImage | null>()
  mock.choose.mockReturnValueOnce(pending.promise)
  const { onChange } = renderSettings()
  const input = screen.getByLabelText('背景图片文件') as HTMLInputElement
  const click = vi.spyOn(input, 'click')
  fireEvent.click(screen.getByRole('button', { name: '选择背景图' }))
  expect(click).toHaveBeenCalledOnce()
  fireEvent.change(input, { target: { files: [browserFile] } })
  expect(mock.choose).toHaveBeenCalledWith(browserFile)
  expect(screen.getByRole('status').textContent).toBe('正在导入背景图…')
  expect(screen.getByRole('button', { name: '选择背景图' }).hasAttribute('disabled')).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
  await act(async () => pending.resolve(replacement))
  expect(onChange).toHaveBeenCalledWith({ backgroundImage: replacement })
  expect(screen.queryByText('正在导入背景图…')).toBeNull()
})

it('uses the native chooser and preserves the current image when the user cancels', async () => {
  mock.desktop = true
  mock.choose.mockResolvedValueOnce(null)
  const { onChange } = renderSettings({ image: original })
  expect(screen.queryByLabelText('背景图片文件')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '更换背景图' }))
  await waitFor(() => expect(mock.choose).toHaveBeenCalledWith(undefined))
  await waitFor(() => expect(screen.queryByText('正在导入背景图…')).toBeNull())
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText(original.name).getAttribute('title')).toBe(original.name)
})

it('keeps the existing image on import failure and retries the same browser file', async () => {
  mock.choose.mockRejectedValueOnce(new Error('Image decoding failed')).mockResolvedValueOnce(replacement)
  const { onChange } = renderSettings({ image: original })
  fireEvent.change(screen.getByLabelText('背景图片文件'), { target: { files: [browserFile] } })
  expect((await screen.findByRole('alert')).textContent).toContain('Image decoding failed')
  expect(screen.getByText(original.name)).toBeTruthy()
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ backgroundImage: replacement }))
  expect(mock.choose).toHaveBeenNthCalledWith(2, browserFile)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('removing an image invalidates an import still in flight', async () => {
  const pending = deferred<AppBackgroundImage | null>()
  mock.choose.mockReturnValueOnce(pending.promise)
  const { onChange } = renderSettings({ image: original })
  fireEvent.change(screen.getByLabelText('背景图片文件'), { target: { files: [browserFile] } })
  fireEvent.click(screen.getByRole('button', { name: '移除背景图' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ backgroundImage: undefined })
  await act(async () => pending.resolve(replacement))
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('正在导入背景图…')).toBeNull()
})

it('ignores older import completions and completions after unmount', async () => {
  const first = deferred<AppBackgroundImage | null>()
  const second = deferred<AppBackgroundImage | null>()
  const third = deferred<AppBackgroundImage | null>()
  mock.choose.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
  const { onChange, unmount } = renderSettings({ image: original })
  const input = screen.getByLabelText('背景图片文件')
  fireEvent.change(input, { target: { files: [browserFile] } })
  fireEvent.change(input, { target: { files: [new File(['other'], 'newer.png', { type: 'image/png' })] } })
  await act(async () => second.resolve(replacement))
  await act(async () => first.resolve({ name: 'obsolete.png', path: '/app/obsolete.png' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ backgroundImage: replacement })
  fireEvent.change(input, { target: { files: [browserFile] } })
  unmount()
  await act(async () => third.resolve(original))
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('changes both opacity values through keyboard sliders and bounded numeric inputs', () => {
  const changes = vi.fn()
  function Harness() {
    const [settings, setSettings] = useState({ backgroundImageOpacity: 100, backgroundSurfaceOpacity: 85 })
    const change = (patch: AppearancePatch) => { changes(patch); setSettings(current => ({ ...current, ...patch })) }
    return <BackgroundSettings image={original} imageOpacity={settings.backgroundImageOpacity} surfaceOpacity={settings.backgroundSurfaceOpacity} onChange={change} disabled={false} />
  }
  render(<Harness />)
  const imageSlider = screen.getByRole('slider', { name: '背景图不透明度' })
  const surfaceSlider = screen.getByRole('slider', { name: '界面背景不透明度' })
  expect(imageSlider.getAttribute('aria-valuenow')).toBe('100')
  expect(surfaceSlider.getAttribute('aria-valuenow')).toBe('85')
  fireEvent.keyDown(imageSlider, { key: 'ArrowLeft' })
  expect(changes).toHaveBeenLastCalledWith({ backgroundImageOpacity: 99 })
  fireEvent.keyDown(surfaceSlider, { key: 'Home' })
  expect(changes).toHaveBeenLastCalledWith({ backgroundSurfaceOpacity: 0 })
  fireEvent.keyDown(surfaceSlider, { key: 'End' })
  expect(changes).toHaveBeenLastCalledWith({ backgroundSurfaceOpacity: 100 })
  const imageNumber = screen.getByRole('spinbutton', { name: '背景图不透明度' }) as HTMLInputElement
  fireEvent.change(imageNumber, { target: { value: '25' } })
  expect(changes).toHaveBeenLastCalledWith({ backgroundImageOpacity: 25 })
  expect(imageSlider.getAttribute('aria-valuenow')).toBe('25')
  fireEvent.change(imageNumber, { target: { value: '125' } })
  fireEvent.blur(imageNumber)
  expect(imageNumber.value).toBe('100')
  fireEvent.change(imageNumber, { target: { value: '' } })
  const beforeBlur = changes.mock.calls.length
  fireEvent.blur(imageNumber)
  expect(imageNumber.value).toBe('100')
  expect(changes).toHaveBeenCalledTimes(beforeBlur)
})

it('disables opacity controls without an image and during import or external loading', async () => {
  const { rerender, onChange } = renderSettings()
  expect(screen.getByRole('spinbutton', { name: '背景图不透明度' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('slider', { name: '背景图不透明度' }).getAttribute('aria-disabled')).toBe('true')
  rerender(<BackgroundSettings image={original} onChange={onChange} disabled={false} loading />)
  expect(screen.getByRole('status').textContent).toBe('正在读取背景图…')
  expect(screen.getByRole('spinbutton', { name: '界面背景不透明度' }).hasAttribute('disabled')).toBe(true)
  rerender(<BackgroundSettings image={original} onChange={onChange} disabled={true} />)
  expect(screen.getByRole('button', { name: '更换背景图' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '移除背景图' }).hasAttribute('disabled')).toBe(true)
})

it('shows image read failures with an accessible retry action', () => {
  const retry = vi.fn()
  renderSettings({ image: original, error: 'Local image cannot be read', onRetry: retry })
  expect(screen.getByRole('alert').textContent).toContain('Local image cannot be read')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(retry).toHaveBeenCalledOnce()
})
