import { Channel, invoke } from '@tauri-apps/api/core'
import { isDesktop } from './bridge'

export interface AppUpdateInfo {
  currentVersion: string
  version?: string
  notes?: string
  releaseUrl?: string
  date?: string
}
export type AppUpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

function requireDesktop() {
  if (!isDesktop) throw new Error('App updates are available in the desktop app.')
}
export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  requireDesktop()
  return invoke<AppUpdateInfo>('check_app_update')
}
export async function downloadAppUpdate(onEvent: (event: AppUpdateDownloadEvent) => void): Promise<void> {
  requireDesktop()
  const channel = new Channel<AppUpdateDownloadEvent>()
  channel.onmessage = onEvent
  return invoke<void>('download_app_update', { onEvent: channel })
}
export async function installAppUpdate(): Promise<void> {
  requireDesktop()
  return invoke<void>('install_app_update')
}
export async function restartAfterAppUpdate(): Promise<void> {
  requireDesktop()
  return invoke<void>('restart_app_after_update')
}
