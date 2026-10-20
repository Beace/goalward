import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { translate } from '@/i18n'
import type { AppBackgroundImage } from './types'

export const MAX_BACKGROUND_IMAGE_BYTES = 32 * 1024 * 1024
export const BACKGROUND_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.ico,.tif,.tiff,.heic,.heif'
const databaseName = 'goalward.appearance-images.v1'
const imageStore = 'images'
const previewPrefix = 'preview-background:'

export type BackgroundImageErrorCode =
  | 'image_not_found'
  | 'image_read_failed'
  | 'not_an_image_file'
  | 'image_too_large'
  | 'image_corrupt'
  | 'storage_path_invalid'
  | 'missing_absolute_path'
  | 'invalid_file_name'
  | 'path_contains_traversal'
  | 'outside_managed_directory'

export function translateBackgroundError(code: BackgroundImageErrorCode): string {
  switch (code) {
    case 'image_not_found':
      return translate('背景图片不存在或无法访问，请重新选择图片。', 'The background image does not exist or cannot be accessed. Choose another image.')
    case 'image_read_failed':
      return translate('背景图片读取失败。', 'Could not read the background image.')
    case 'not_an_image_file':
      return translate('此路径不是图片文件。', 'This path is not an image file.')
    case 'image_too_large':
      return translate('背景图片超过 32 MB，请选择较小的图片。', 'The background image exceeds 32 MB. Choose a smaller image.')
    case 'image_corrupt':
      return translate('背景图片内容已损坏，无法显示。', 'The background image is corrupted and cannot be displayed.')
    case 'storage_path_invalid':
      return translate('背景图片存储路径无效。', 'The background image storage path is invalid.')
    case 'missing_absolute_path':
      return translate('背景图片缺少本地绝对路径。', 'The background image is missing an absolute local path.')
    case 'invalid_file_name':
      return translate('背景图片文件名无效。', 'The background image file name is invalid.')
    case 'path_contains_traversal':
      return translate('背景图片路径无效，请重新选择图片。', 'The background image path is invalid. Choose another image.')
    case 'outside_managed_directory':
      return translate('只能读取 App 管理的背景图片。', 'Only app-managed background images can be read.')
    default:
      return translate('背景图片加载失败，请重试或更换图片。', 'The background image could not be loaded. Retry or choose another image.')
  }
}

const backgroundErrorCodes = new Set<string>([
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
])

interface BackgroundImportResult {
  name: string
  path: string
}

interface BackgroundAssetResult {
  path: string
}

function isBackgroundErrorCode(value: string): value is BackgroundImageErrorCode {
  return backgroundErrorCodes.has(value)
}

/** Tauri rejects command errors. The payload is `{ error: "<code>" }`, a code string, or that JSON as text. */
export function backgroundErrorCode(value: unknown, depth = 0): BackgroundImageErrorCode | undefined {
  if (depth > 3) return undefined
  if (typeof value === 'string') {
    const text = value.trim().replace(/^Error:\s*/, '')
    if (isBackgroundErrorCode(text)) return text
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return backgroundErrorCode(JSON.parse(text), depth + 1)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (value instanceof Error) return backgroundErrorCode(value.message, depth + 1)
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if ('error' in record) {
    const nested = backgroundErrorCode(record.error, depth + 1)
    if (nested) return nested
  }
  if ('code' in record) {
    const nested = backgroundErrorCode(record.code, depth + 1)
    if (nested) return nested
  }
  if (typeof record.message === 'string') return backgroundErrorCode(record.message, depth + 1)
  return undefined
}

function localizedBackgroundFailure(cause: unknown): string {
  const code = backgroundErrorCode(cause)
  if (code) return translateBackgroundError(code)
  return translate('背景图片加载失败，请重试或更换图片。', 'The background image could not be loaded. Retry or choose another image.')
}

async function invokeBackground<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    throw new Error(localizedBackgroundFailure(cause))
  }
}

function unsupportedImage(): Error {
  return new Error(translate('此文件不是受支持的图片，或图片内容已损坏。', 'This file is not a supported image, or its contents are damaged.'))
}

function checkSize(size: number): void {
  if (size > MAX_BACKGROUND_IMAGE_BYTES) throw new Error(translate('背景图片超过 32 MB，请选择较小的图片。', 'The background image exceeds 32 MB. Choose a smaller image.'))
  if (size === 0) throw unsupportedImage()
}

/** Match file bytes, never the extension or the caller-provided MIME type. */
function imageMime(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif'
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp'
  if (text(0, 2) === 'BM') return 'image/bmp'
  if (starts(0, 0, 1, 0)) return 'image/x-icon'
  if (starts(0x49, 0x49, 0x2a, 0) || starts(0x4d, 0x4d, 0, 0x2a)) return 'image/tiff'
  if (text(4, 4) === 'ftyp') {
    const brand = text(8, 4)
    if (['avif', 'avis'].includes(brand)) return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  return null
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(unsupportedImage())
    reader.onerror = () => reject(new Error(translate('背景图片读取失败。', 'Could not read the background image.')))
    reader.readAsArrayBuffer(blob)
  })
}

async function readableImage(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(unsupportedImage())
      image.onerror = () => reject(new Error(translate('此图片无法在当前应用中显示，请转换为 PNG、JPEG 或 WebP 后重试。', 'This image cannot be displayed in this app. Convert it to PNG, JPEG, or WebP and try again.')))
      image.src = url
    })
  } finally {
    image.onload = null
    image.onerror = null
    image.src = ''
    URL.revokeObjectURL(url)
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(translate('浏览器无法保存背景图片，请在桌面应用中设置。', 'The browser cannot save background images. Set one in the desktop app.')))
      return
    }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(imageStore)) request.result.createObjectStore(imageStore)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(translate('背景图片存储无法打开。', 'Could not open background image storage.')))
    request.onblocked = () => reject(new Error(translate('背景图片存储正在被另一窗口使用，请关闭该窗口后重试。', 'Background image storage is in use by another window. Close it and try again.')))
  })
}

async function storeImage(path: string, blob: Blob): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(imageStore, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = transaction.onabort = () => reject(new Error(translate('背景图片保存失败，浏览器存储空间可能不足。', 'Could not save the background image. Browser storage may be full.')))
      transaction.objectStore(imageStore).put(blob, path)
    })
  } finally {
    database.close()
  }
}

async function storedImage(path: string): Promise<Blob> {
  const database = await openDatabase()
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const request = database.transaction(imageStore, 'readonly').objectStore(imageStore).get(path)
      request.onsuccess = () => request.result instanceof Blob ? resolve(request.result) : reject(new Error(translate('背景图片不存在，浏览器存储可能已被清除，请重新选择图片。', 'The background image is missing. Browser storage may have been cleared. Choose the image again.')))
      request.onerror = () => reject(new Error(translate('背景图片读取失败。', 'Could not read the background image.')))
    })
  } finally {
    database.close()
  }
}

/** Native assets are copied into app storage; browser previews retain Blobs in IndexedDB. */
export async function chooseBackgroundImage(file?: File): Promise<AppBackgroundImage | null> {
  if (isTauri()) {
    const path = await open({
      multiple: false,
      title: translate('选择 App 背景图片', 'Choose app background image'),
      filters: [{ name: translate('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif'] }],
    })
    if (typeof path !== 'string') return null
    const result = await invokeBackground<BackgroundImportResult>('import_background_image', { path })
    return { name: result.name, path: result.path }
  }
  if (!file) return null
  checkSize(file.size)
  const bytes = await readBytes(file)
  checkSize(bytes.byteLength)
  const mime = imageMime(new Uint8Array(bytes))
  if (!mime) throw unsupportedImage()
  const blob = new Blob([bytes], { type: mime })
  await readableImage(blob)
  const path = `${previewPrefix}${crypto.randomUUID()}`
  const name = file.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'background-image'
  // Retain prior assets: a failed settings save may restore an earlier reference.
  await storeImage(path, blob)
  return { name, path }
}

/** The caller owns any returned blob URL and must revoke it when no longer used. */
export async function loadBackgroundImage(image: AppBackgroundImage): Promise<string> {
  if (isTauri()) {
    const result = await invokeBackground<BackgroundAssetResult>('read_background_image', { path: image.path })
    return convertFileSrc(result.path)
  }
  if (!/^preview-background:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(image.path)) {
    throw new Error(translate('此背景图片只能在原来的桌面应用或浏览器中读取，请重新选择图片。', 'This background image can only be read in its original app or browser. Choose the image again.'))
  }
  const blob = await storedImage(image.path)
  checkSize(blob.size)
  if (!imageMime(new Uint8Array(await readBytes(blob)))) throw unsupportedImage()
  return URL.createObjectURL(blob)
}
