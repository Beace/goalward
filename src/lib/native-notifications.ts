import { invoke, isTauri } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import type { CompletionNotification } from './completion-notifications'

let permissionCheck: Promise<boolean> | undefined
let requested = false

async function canNotify(): Promise<boolean> {
  if (await isPermissionGranted()) return true
  if (requested) return false
  requested = true
  return await requestPermission() === 'granted'
}

export async function sendNativeNotification(notification: CompletionNotification): Promise<void> {
  if (!isTauri()) return
  // Concurrent completions share one permission request. Recheck the plugin on
  // the next completion; the OS ultimately controls whether a banner appears.
  const check = permissionCheck ??= canNotify()
  let granted: boolean
  try { granted = await check }
  finally { if (permissionCheck === check) permissionCheck = undefined }
  if (!granted) return
  // The plugin's sendNotification() wrapper returns void. Await its native
  // command directly so IPC failures are handled, never unhandled. Plugin
  // acceptance is not an acknowledgement that the OS displayed the banner.
  await invoke<void>('plugin:notification|notify', { options: notification })
}
