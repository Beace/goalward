import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultBackgroundImageOpacity, defaultBackgroundSurfaceOpacity, normalizeBackgroundOpacity } from '@/lib/background'
import { loadBackgroundImage } from '@/lib/background-image'
import type { Settings } from '@/lib/types'
import { translate } from '@/i18n'

type BackgroundSettings = Pick<Settings, 'backgroundImage' | 'backgroundImageOpacity' | 'backgroundSurfaceOpacity'>
export interface AppearanceBackgroundState {
  src?: string
  loading: boolean
  error?: string
  retry: () => void
}

function releaseImage(src: string | undefined) {
  // Only blob URLs need revoking; asset protocol URLs are managed by Tauri
  if (src?.startsWith('blob:')) URL.revokeObjectURL(src)
}

/** Readable bytes may still be an image WebKit cannot decode. Keep the opaque fallback until ready. */
function decodeImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const failure = () => reject(new Error(translate('背景图片无法解码，请重新选择图片或重试。', 'Background image could not be decoded. Choose another image or retry.')))
    image.onload = () => resolve()
    image.onerror = failure
    image.src = src
    if (typeof image.decode === 'function') void image.decode().then(resolve, failure)
  })
}

/** Lives in App so page switches do not restart image I/O or lose a recoverable error. */
export function useAppearanceBackground(settings: BackgroundSettings | undefined): AppearanceBackgroundState {
  const image = settings?.backgroundImage
  const path = image?.path
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; src?: string; error?: string }>()
  const key = JSON.stringify([path, attempt])
  const current = result?.key === key ? result : undefined
  const src = current?.src
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const imageOpacity = normalizeBackgroundOpacity(settings?.backgroundImageOpacity, defaultBackgroundImageOpacity)
  const surfaceOpacity = normalizeBackgroundOpacity(settings?.backgroundSurfaceOpacity, defaultBackgroundSurfaceOpacity)
  const lastOpacity = useRef({ image: imageOpacity, surface: surfaceOpacity })
  const adjustmentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!path || !image) return
    let active = true
    let ownedSrc: string | undefined
    void loadBackgroundImage(image).then(async loaded => {
      if (!active) { releaseImage(loaded); return }
      ownedSrc = loaded
      await decodeImage(loaded)
      if (active) setResult({ key, src: loaded })
    }).catch(error => {
      releaseImage(ownedSrc)
      ownedSrc = undefined
      if (active) setResult({ key, error: String(error).replace(/^Error: /, '') })
    })
    return () => { active = false; releaseImage(ownedSrc); ownedSrc = undefined }
    // A display-name change does not reread the same image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key])

  useLayoutEffect(() => {
    const root = document.documentElement
    if (src) root.dataset.appBackground = 'ready'
    else delete root.dataset.appBackground
    if (lastOpacity.current.image !== imageOpacity || lastOpacity.current.surface !== surfaceOpacity) {
      // A slider directly controls the current presentation, including during a
      // concurrent theme crossfade. This flag only cancels CSS interpolation.
      clearTimeout(adjustmentTimer.current)
      root.classList.add('background-adjusting')
      adjustmentTimer.current = setTimeout(() => root.classList.remove('background-adjusting'), 250)
      lastOpacity.current = { image: imageOpacity, surface: surfaceOpacity }
    }
    root.style.setProperty('--app-background-image-opacity', `${imageOpacity}%`)
    root.style.setProperty('--app-surface-opacity', `${surfaceOpacity}%`)
  }, [src, imageOpacity, surfaceOpacity])

  useLayoutEffect(() => () => {
    clearTimeout(adjustmentTimer.current)
    const root = document.documentElement
    delete root.dataset.appBackground
    root.classList.remove('background-adjusting')
    root.style.removeProperty('--app-background-image-opacity')
    root.style.removeProperty('--app-surface-opacity')
  }, [])

  return { src, loading: Boolean(path && !current), error: current?.error, retry }
}
