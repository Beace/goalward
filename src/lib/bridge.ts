import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { PREVIEW_FONT_FAMILIES } from './fonts'
import { StatePersistence } from './state-persistence'
import { translate } from '@/i18n'
import type { AppState, LocalDiscoveryReport, ProbeResult, RuntimeEvent, StartRequest, StorageInfo, Task } from './types'

export const isDesktop = isTauri()
export async function listSystemFonts(): Promise<string[]> {
  return isDesktop ? invoke<string[]>('list_system_fonts') : [...PREVIEW_FONT_FAMILIES]
}

const previewKey = 'goalward.preview.v1'
const legacyPreviewKey = 'super-agents.preview.v1'
const persistence = new StatePersistence()
let saveQueue: Promise<void> = Promise.resolve()

function previewStateJson(): string | null {
  const current = localStorage.getItem(previewKey)
  if (current !== null) return current
  const legacy = localStorage.getItem(legacyPreviewKey)
  if (legacy === null) return null
  // Retain the previous key so older preview builds and user data remain untouched.
  localStorage.setItem(previewKey, legacy)
  const backup = localStorage.getItem(`${legacyPreviewKey}.backup`)
  if (backup !== null && localStorage.getItem(`${previewKey}.backup`) === null) {
    localStorage.setItem(`${previewKey}.backup`, backup)
  }
  return legacy
}

/** Only explicit web URLs can leave the workbench; never dispatch local files or app schemes. */
export function normalizeExternalHttpUrl(value: string): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export async function openExternalUrl(value: string): Promise<void> {
  const url = normalizeExternalHttpUrl(value)
  if (!url) throw new Error(translate('只能打开不含登录凭证的 HTTP 或 HTTPS 网页链接。', 'Only HTTP or HTTPS links without login credentials can be opened.'))
  if (isDesktop) return invoke<void>('open_external_url', { url })
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function loadState(): Promise<AppState | null> {
  if (isDesktop) {
    const state = await invoke<AppState | null>('load_workspace_summary')
    persistence.loaded(state)
    return state
  }
  const json = previewStateJson()
  return json ? JSON.parse(json) : null
}
export async function loadTaskHistory(taskId: string, signal?: AbortSignal): Promise<RuntimeEvent[]> {
  if (!isDesktop) return []
  const events: RuntimeEvent[] = []
  let after = -1
  let through: number | null = null
  do {
    signal?.throwIfAborted()
    const page: { events: RuntimeEvent[]; next: number | null; through: number } = await invoke('load_task_event_page', { taskId, after, through })
    signal?.throwIfAborted()
    persistence.remember(page.events)
    events.push(...page.events)
    if (page.next === null) break
    if (page.next <= after) throw new Error(translate('历史记录分页游标未前进', 'History pagination cursor did not advance'))
    after = page.next
    through = page.through
  } while (true)
  return events
}
export async function saveState(state: AppState) {
  if (isDesktop) {
    const operation = saveQueue.then(async () => {
      await invoke<void>('save_state_delta', { state: persistence.prepare(state) })
      persistence.committed(state)
    })
    saveQueue = operation.catch(() => {})
    return operation
  }
  const previous = previewStateJson()
  if (previous && state.version === 2 && JSON.parse(previous).version === 1 && !localStorage.getItem(`${previewKey}.backup`)) localStorage.setItem(`${previewKey}.backup`, previous)
  localStorage.setItem(previewKey, JSON.stringify(state))
}
export async function loadTraceEvents(state: AppState): Promise<RuntimeEvent[]> {
  if (!isDesktop) return []
  const refs = state.tasks.filter(task => !task.demo).flatMap(task => task.runs.flatMap(run => run.members.map(member => ({ taskId: task.id, runId: run.id, memberId: member.id }))))
  const knownEventIds = Object.fromEntries(state.tasks.filter(task => !task.demo).map(task => [task.id, task.events.map(event => event.id)]))
  return invoke('load_trace_events', { refs, knownEventIds })
}
export async function probeRuntime(executable: string): Promise<ProbeResult> {
  if (!isDesktop) return { found: false, path: executable, version: '', error: translate('请在 macOS 应用中检测本机 Runtime。', 'Detect local runtimes in the macOS app.') }
  return invoke('probe_runtime', { executable })
}
export async function discoverLocalEnvironment(): Promise<LocalDiscoveryReport> {
  if (!isDesktop) throw new Error(translate('浏览器预览无法检测本机环境，请在 macOS 应用中使用自动检测。', 'The browser preview cannot scan your local environment. Use automatic detection in the macOS app.'))
  return invoke('discover_local_environment')
}
export async function chooseDirectory(): Promise<string | null> {
  if (!isDesktop) throw new Error(translate('浏览器预览无法读取本机目录，请输入路径或打开 macOS 应用。', 'The browser preview cannot read local directories. Enter a path or open the macOS app.'))
  const result = await open({ directory: true, multiple: false, title: translate('选择任务工作目录', 'Choose task working directory') })
  return typeof result === 'string' ? result : null
}
export async function chooseFile(): Promise<string | null> {
  if (!isDesktop) throw new Error(translate('请在 macOS 应用中选择可执行文件。', 'Choose an executable in the macOS app.'))
  const result = await open({ multiple: false, title: translate('选择 Runtime 可执行文件', 'Choose runtime executable') })
  return typeof result === 'string' ? result : null
}
export async function storageInfo(): Promise<StorageInfo> {
  return isDesktop ? invoke('storage_info') : { path: translate('浏览器本地预览存储', 'Browser preview storage'), bytes: new Blob([previewStateJson() ?? '']).size }
}
export async function startRun(request: StartRequest) {
  if (!isDesktop) throw new Error(translate('浏览器提供界面预览；请在 macOS 应用中执行本机 Agent。', 'The browser is for UI preview; run local agents in the macOS app.'))
  return invoke<void>('start_run', { request })
}
export async function stopRun(runId: string, memberId?: string) {
  return invoke<void>('stop_run', { runId, memberId: memberId ?? null })
}
export async function onRuntimeEvent(handler: (event: RuntimeEvent) => void) {
  return isDesktop ? listen<RuntimeEvent>('runtime-event', ({ payload }) => handler(payload)) : () => {}
}
export async function exportTask(task: Task): Promise<string> {
  if (isDesktop) return invoke('export_task', { task })
  const url = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = `goalward-${task.id}.json`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return a.download
}

export interface ArtifactFile { path: string; content: string; imageDataUrl?: string; bytes: number }
export async function readArtifact(directory: string, path: string): Promise<ArtifactFile> {
  if (!isDesktop) throw new Error(translate('本地文件请在桌面应用中预览；回复内的文档可直接预览。', 'Preview local files in the desktop app. Documents in responses can be previewed here.'))
  return invoke('read_artifact', { directory, path })
}
export async function openArtifact(directory: string, path: string, reveal = false): Promise<void> {
  if (!isDesktop) throw new Error(translate('请在桌面应用中打开本地文件。', 'Open local files in the desktop app.'))
  return invoke('open_artifact', { directory, path, reveal })
}
export async function saveArtifact(name: string, content: string): Promise<string | null> {
  if (isDesktop) return invoke('save_artifact', { name, content })
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}
