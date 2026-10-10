import { useCallback, useEffect, useRef, useState } from 'react'
import { version } from '../../package.json'
import { isDesktop } from '@/lib/bridge'
import { checkAppUpdate, downloadAppUpdate, installAppUpdate, restartAfterAppUpdate, type AppUpdateInfo } from '@/lib/app-update'

export const APP_UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'restarting'
export type UpdateStage = 'check' | 'download' | 'install' | 'restart'
export interface AppUpdateState {
  phase: UpdatePhase
  info: AppUpdateInfo
  checkedAt?: string
  downloadedBytes: number
  totalBytes?: number
  error?: { stage: UpdateStage; message: string }
}
export interface AppUpdateOptions {
  ready: boolean
  /** Rechecked at click time, independently of disabled controls. */
  canApplyUpdate: () => boolean
  onAvailable: (info: AppUpdateInfo) => void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const initialState = (): AppUpdateState => ({ phase: 'idle', info: { currentVersion: version }, downloadedBytes: 0 })

export function useAppUpdate(options: AppUpdateOptions) {
  const [state, setState] = useState<AppUpdateState>(initialState)
  const current = useRef(state)
  const latestOptions = useRef(options)
  latestOptions.current = options
  const live = useRef(true)
  const busy = useRef(false)
  const notified = useRef(new Set<string>())
  const change = useCallback((next: AppUpdateState) => {
    current.current = next
    if (live.current) setState(next)
  }, [])
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  const check = useCallback(async () => {
    if (!isDesktop || !latestOptions.current.ready || busy.current || !['idle', 'current', 'available'].includes(current.current.phase)) return
    // Download/install retries retain the native verified package and their stage.
    if (current.current.error && current.current.error.stage !== 'check') return
    busy.current = true
    const previous = current.current
    change({ ...previous, phase: 'checking', error: undefined })
    try {
      const info = await checkAppUpdate()
      change({ phase: info.version ? 'available' : 'current', info, checkedAt: new Date().toISOString(), downloadedBytes: 0 })
      if (live.current && info.version && !notified.current.has(info.version)) {
        notified.current.add(info.version)
        latestOptions.current.onAvailable(info)
      }
    } catch (error) {
      change({ ...previous, error: { stage: 'check', message: message(error) } })
    } finally { busy.current = false }
  }, [change])

  const download = useCallback(async () => {
    if (!isDesktop || busy.current || current.current.phase !== 'available' || !current.current.info.version) return
    busy.current = true
    change({ ...current.current, phase: 'downloading', error: undefined, downloadedBytes: 0, totalBytes: undefined })
    let receiving = true
    try {
      await downloadAppUpdate(event => {
        if (!receiving) return
        const previous = current.current
        if (event.event === 'Started') change({ ...previous, totalBytes: event.data.contentLength })
        else if (event.event === 'Progress') change({ ...previous, downloadedBytes: previous.downloadedBytes + event.data.chunkLength })
        // Only a successful command response confirms the signature was verified.
      })
      change({ ...current.current, phase: 'downloaded' })
    } catch (error) {
      change({ ...current.current, phase: 'available', error: { stage: 'download', message: message(error) } })
    } finally { receiving = false; busy.current = false }
  }, [change])

  const install = useCallback(async () => {
    if (!isDesktop || busy.current || current.current.phase !== 'downloaded' || !latestOptions.current.canApplyUpdate()) return
    busy.current = true
    change({ ...current.current, phase: 'installing', error: undefined })
    try {
      await installAppUpdate()
      change({ ...current.current, phase: 'installed' })
    } catch (error) {
      change({ ...current.current, phase: 'downloaded', error: { stage: 'install', message: message(error) } })
    } finally { busy.current = false }
  }, [change])

  const restart = useCallback(async () => {
    if (!isDesktop || busy.current || current.current.phase !== 'installed' || !latestOptions.current.canApplyUpdate()) return
    busy.current = true
    change({ ...current.current, phase: 'restarting', error: undefined })
    try { await restartAfterAppUpdate() }
    catch (error) { change({ ...current.current, phase: 'installed', error: { stage: 'restart', message: message(error) } }) }
    finally { busy.current = false }
  }, [change])

  useEffect(() => {
    if (!isDesktop || !options.ready) return
    void check()
    const timer = window.setInterval(() => {
      if (['idle', 'current', 'available'].includes(current.current.phase)) void check()
    }, APP_UPDATE_CHECK_INTERVAL)
    return () => window.clearInterval(timer)
  }, [options.ready, check])

  return { ...state, desktop: isDesktop, check, download, install, restart }
}
export type AppUpdateController = ReturnType<typeof useAppUpdate>
