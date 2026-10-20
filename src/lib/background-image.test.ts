// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseBackgroundImage, loadBackgroundImage, MAX_BACKGROUND_IMAGE_BYTES, translateBackgroundError, type BackgroundImageErrorCode } from './background-image'

const mock = vi.hoisted(() => ({ desktop: false, invoke: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, isTauri: () => mock.desktop }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mock.open }))

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
let saved: Map<string, Blob>
let decodedBlobs: Blob[]
let decodeFails: boolean
let storageFails: boolean
let revoked: string[]
let nextUrl: number

beforeEach(() => {
  mock.desktop = false
  mock.invoke.mockReset()
  mock.open.mockReset()
  saved = new Map()
  decodedBlobs = []
  revoked = []
  decodeFails = false
  storageFails = false
  nextUrl = 0
  vi.stubGlobal('Image', class {
    naturalWidth = 1
    naturalHeight = 1
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(value: string) {
      if (value) queueMicrotask(() => decodeFails ? this.onerror?.() : this.onload?.())
    }
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    decodedBlobs.push(blob as Blob)
    return `blob:background-${++nextUrl}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url) })
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = { result: {
        objectStoreNames: { contains: () => true },
        close: vi.fn(),
        transaction: () => {
          const transaction = {
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
            objectStore: () => ({
              put: (blob: Blob, key: string) => {
                queueMicrotask(() => {
                  if (storageFails) transaction.onerror?.()
                  else { saved.set(key, blob); transaction.oncomplete?.() }
                })
              },
              get: (key: string) => {
                const value = { result: saved.get(key), onsuccess: null as (() => void) | null, onerror: null }
                queueMicrotask(() => value.onsuccess?.())
                return value
              },
            }),
          }
          return transaction
        },
      }, onsuccess: null as (() => void) | null, onerror: null, onupgradeneeded: null }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

it('uses native selection, imports a managed reference, and treats cancellation as no change', async () => {
  mock.desktop = true
  const image = { name: 'wallpaper.png', path: '/app/appearance/backgrounds/id/wallpaper.png' }
  mock.open.mockResolvedValueOnce('/original/wallpaper.png').mockResolvedValueOnce(null)
  mock.invoke.mockResolvedValueOnce(image).mockResolvedValueOnce({ url: 'asset://localhost/app/appearance/backgrounds/id/wallpaper.png' })
  expect(await chooseBackgroundImage()).toEqual(image)
  expect(mock.invoke).toHaveBeenCalledWith('import_background_image', { path: '/original/wallpaper.png' })
  expect(mock.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, filters: [expect.objectContaining({ extensions: expect.arrayContaining(['png', 'webp', 'avif', 'heic', 'tiff']) })] }))
  expect(await loadBackgroundImage(image)).toBe('asset://localhost/app/appearance/backgrounds/id/wallpaper.png')
  expect(mock.invoke).toHaveBeenLastCalledWith('read_background_image', { path: image.path })
  expect(await chooseBackgroundImage()).toBeNull()
  expect(mock.invoke).toHaveBeenCalledTimes(2)
})

it('stores browser bytes separately from settings and preserves earlier assets for rollback and reload', async () => {
  const image = await chooseBackgroundImage(new File([png], 'wallpaper.png', { type: 'text/plain' }))
  const next = await chooseBackgroundImage(new File([png], 'next.png'))
  expect(image).toEqual({ name: 'wallpaper.png', path: expect.stringMatching(/^preview-background:/) })
  expect(Object.keys(image!)).toEqual(['name', 'path'])
  expect(next!.path).not.toBe(image!.path)
  expect(saved.size).toBe(2)
  expect(await blobBytes(saved.get(image!.path)!)).toEqual(png.buffer)
  expect(saved.get(image!.path)!.type).toBe('image/png')
  expect(revoked).toEqual(['blob:background-1', 'blob:background-2'])
  expect(await loadBackgroundImage(image!)).toBe('blob:background-3')
  // The renderer owns loaded URLs; import-only temporary URLs were revoked above.
  expect(revoked).toHaveLength(2)
  expect(await loadBackgroundImage(next!)).toBe('blob:background-4')
})

it('does not fabricate a reference when browser selection is cancelled', async () => {
  expect(await chooseBackgroundImage()).toBeNull()
  expect(saved.size).toBe(0)
  expect(decodedBlobs).toHaveLength(0)
})

it.each(['<svg></svg>', '<html>active content</html>', 'not an image'])('rejects forged image extensions and MIME types: %s', async bytes => {
  await expect(chooseBackgroundImage(new File([bytes], 'forged.png', { type: 'image/png' }))).rejects.toThrow('不是受支持的图片')
  expect(saved.size).toBe(0)
  expect(decodedBlobs).toHaveLength(0)
})

it('rejects oversized and empty files before encoding or opening storage', async () => {
  const large = new File([png], 'large.png')
  Object.defineProperty(large, 'size', { value: MAX_BACKGROUND_IMAGE_BYTES + 1 })
  await expect(chooseBackgroundImage(large)).rejects.toThrow('32 MB')
  await expect(chooseBackgroundImage(new File([], 'empty.png'))).rejects.toThrow('不是受支持的图片')
  expect(saved.size).toBe(0)
  expect(decodedBlobs).toHaveLength(0)
})

it('rejects unreadable images and releases the temporary URL without persisting a reference', async () => {
  decodeFails = true
  await expect(chooseBackgroundImage(new File([png], 'damaged.png'))).rejects.toThrow('转换为 PNG')
  expect(saved.size).toBe(0)
  expect(revoked).toEqual(['blob:background-1'])
})

it('surfaces storage failure without returning an unusable settings reference', async () => {
  storageFails = true
  await expect(chooseBackgroundImage(new File([png], 'image.png'))).rejects.toThrow('保存失败')
  expect(saved.size).toBe(0)
  expect(revoked).toEqual(['blob:background-1'])
})

it('reports a missing stored asset and rejects arbitrary persisted paths', async () => {
  await expect(loadBackgroundImage({ name: 'image.png', path: 'preview-background:00000000-0000-0000-0000-000000000000' })).rejects.toThrow('背景图片不存在')
  for (const path of ['/tmp/image.png', 'https://example.com/image.png', 'data:image/svg+xml,svg', 'preview-background:../../outside']) {
    await expect(loadBackgroundImage({ name: 'image.png', path })).rejects.toThrow('重新选择图片')
  }
  expect(decodedBlobs).toHaveLength(0)
})

it('checks bytes again when loading persisted browser assets', async () => {
  const path = 'preview-background:00000000-0000-0000-0000-000000000000'
  saved.set(path, new Blob(['<svg></svg>'], { type: 'image/png' }))
  await expect(loadBackgroundImage({ name: 'forged.png', path })).rejects.toThrow('不是受支持的图片')
  expect(decodedBlobs).toHaveLength(0)
})

describe('translateBackgroundError', () => {
  const errorCodes: BackgroundImageErrorCode[] = [
    'image_not_found',
    'image_read_failed',
    'not_an_image_file',
    'image_too_large',
    'image_corrupt',
    'storage_path_invalid',
    'missing_absolute_path',
    'invalid_file_name',
    'path_contains_traversal',
    'outside_managed_directory',
  ]

  it.each(errorCodes)('translates %s to a user-friendly message', (code) => {
    const message = translateBackgroundError(code)
    expect(message).toBeTruthy()
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(5)
  })

  it('handles unknown error codes gracefully', () => {
    const message = translateBackgroundError('unknown_error' as BackgroundImageErrorCode)
    expect(message).toBeTruthy()
    expect(typeof message).toBe('string')
  })
})

describe('native error handling', () => {
  it('translates backend error codes to localized messages on import', async () => {
    mock.desktop = true
    mock.open.mockResolvedValueOnce('/path/to/image.png')
    mock.invoke.mockResolvedValueOnce({ error: 'image_too_large' })
    await expect(chooseBackgroundImage()).rejects.toThrow('32 MB')
  })

  it('translates backend error codes to localized messages on load', async () => {
    mock.desktop = true
    mock.invoke.mockResolvedValueOnce({ error: 'image_not_found' })
    await expect(loadBackgroundImage({ name: 'image.png', path: '/app/backgrounds/image.png' })).rejects.toThrow()
  })

  it('returns asset protocol URL from native load', async () => {
    mock.desktop = true
    mock.invoke.mockResolvedValueOnce({ url: 'asset://localhost/app/backgrounds/uuid/image.png' })
    const url = await loadBackgroundImage({ name: 'image.png', path: '/app/backgrounds/uuid/image.png' })
    expect(url).toBe('asset://localhost/app/backgrounds/uuid/image.png')
    expect(url.startsWith('asset://')).toBe(true)
  })
})
