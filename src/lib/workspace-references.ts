import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './bridge'
import { translate } from '@/i18n'

export interface WorkspaceEntry { name: string; path: string; relativePath: string; root: string; kind: 'file' | 'folder' }
export interface WorkspaceSearchResult { entries: WorkspaceEntry[]; truncated: boolean }
export interface MentionQuery { start: number; end: number; query: string }

/** Only an unfinished @ token at the caret opens search; e-mail and committed
 * JSON-quoted paths remain ordinary text. Paths containing spaces are quoted. */
export function mentionQuery(value: string, caret: number): MentionQuery | undefined {
  const prefix = value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@"\n]*)$/.exec(prefix)
  if (!match) return
  return { start: caret - match[1].length - 1, end: caret, query: match[1] }
}
export function insertWorkspaceReference(value: string, query: MentionQuery, entry: WorkspaceEntry) {
  const token = `@${JSON.stringify(entry.path)} `
  return { value: value.slice(0, query.start) + token + value.slice(query.end), caret: query.start + token.length }
}
export async function searchWorkspaceEntries(directories: string[], query: string): Promise<WorkspaceSearchResult> {
  if (!isDesktop) throw new Error(translate('请在桌面应用中引用工作目录里的文件或文件夹。', 'Reference local files and folders in the desktop app.'))
  return invoke('search_workspace_entries', { directories, query })
}
