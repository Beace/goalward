import { AnimatedNumber } from '@/components/ui/animated-number'
import { useState } from 'react'
import { FolderOpen, Plus, Star, X } from 'lucide-react'
import type { AppState } from '@/lib/types'
import type { Goal } from '@/lib/goal-types'
import { applyGoalWorkingDirectories, getGoalWorkingDirectories, normalizeWorkingDirectories } from '@/lib/working-directories'
import { chooseDirectory, isDesktop } from '@/lib/bridge'
import { persistGoalAssistantAction } from './GoalAssistant'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from './ui/collapsible'
import { useI18n } from '@/i18n'
import './goal-workspace-directories.css'

/** One fixed workspace definition per goal; details expand without a separate editor dialog. */
export function GoalWorkspaceDirectories({ state, goal, onChange }: { state: AppState; goal: Goal; onChange: (reducer: (state: AppState) => AppState) => Promise<void> }) {
  const { t } = useI18n()
  const roots = getGoalWorkingDirectories(state, goal)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const save = async (change: (roots: string[]) => string[]) => {
    if (busy) return false
    setBusy(true); setError(''); setSaved(false)
    try {
      await persistGoalAssistantAction(onChange, current => {
        const latest = current.goals.find(item => item.id === goal.id)
        if (!latest) throw new Error(t('目标不存在', 'Goal does not exist'))
        return applyGoalWorkingDirectories(current, goal.id, change(getGoalWorkingDirectories(current, latest)))
      })
      setSaved(true); return true
    } catch (cause) { setError(String(cause).replace(/^Error: /, '')); return false }
    finally { setBusy(false) }
  }
  const add = async (value: string) => {
    if (!value.trim()) return
    if (await save(current => normalizeWorkingDirectories([...current, value]))) setPath('')
  }
  return <Collapsible className="goal-workspaces">
    <CollapsibleTrigger asChild><Button variant="ghost" className="goal-workspaces-trigger" aria-label={t('管理目标工作目录', 'Manage goal working directories')}>
      <FolderOpen size={14} /><span>{busy ? t('保存中…', 'Saving…') : t('工作目录', 'Working directories')}</span>
      <span className="goal-workspace-summary" title={roots.join('\n')}>{roots[0] || t('自动使用目标专属目录', 'Use a dedicated goal directory automatically')}</span>
      {roots.length > 1 && <Badge variant="outline">+<AnimatedNumber value={roots.length - 1} /></Badge>}<CollapsibleIndicator size={13} />
    </Button></CollapsibleTrigger>
    <CollapsibleContent><div className="goal-workspaces-body">
      {roots.map((directory, index) => <div className="goal-workspace-row" key={directory}>
        <FolderOpen size={14} aria-hidden="true" /><span title={directory} className="goal-workspace-path">{directory}</span>
        {index === 0 ? <Badge variant="outline">{t('主目录', 'Primary')}</Badge> : <Button variant="ghost" size="icon-sm" disabled={busy} title={t('设为主目录', 'Set as primary')} aria-label={`${t('设为主目录', 'Set as primary')}: ${directory}`} onClick={() => void save(current => [directory, ...current.filter(item => item !== directory)])}><Star size={13} /></Button>}
        <Button variant="ghost" size="icon-sm" disabled={busy || roots.length < 2} title={roots.length < 2 ? t('保留一个主目录', 'Keep one primary directory') : t('移除目录引用', 'Remove directory reference')} aria-label={`${t('移除目录引用', 'Remove directory reference')}: ${directory}`} onClick={() => void save(current => current.filter(item => item !== directory))}><X size={13} /></Button>
      </div>)}
      <div className="goal-workspace-add"><Input aria-label={t('添加目标工作目录路径', 'Add goal directory path')} placeholder={t('添加文件夹的完整路径', 'Add a full directory path')} disabled={busy} value={path} onChange={event => { setPath(event.target.value); setSaved(false) }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void add(path) } }} />
        {isDesktop && <Button variant="outline" size="icon-sm" disabled={busy} title={t('选择目标工作目录', 'Choose goal directory')} aria-label={t('选择目标工作目录', 'Choose goal directory')} onClick={() => void chooseDirectory().then(async value => { if (value) await add(value) }).catch(cause => setError(String(cause).replace(/^Error: /, '')))}><FolderOpen size={14} /></Button>}
        <Button variant="outline" size="icon-sm" disabled={busy || !path.trim()} title={t('添加工作目录', 'Add directory')} aria-label={t('添加工作目录', 'Add directory')} onClick={() => void add(path)}><Plus size={14} /></Button>
      </div>
      <p className="goal-meta">{t('任务继承这些目录；调整在下次执行生效。移除引用不会删除文件。', 'Tasks inherit these directories. Changes apply to future turns. Removing a reference does not delete files.')}</p>
      {error && <p role="alert" className="goal-form-error">{error}</p>}
      {saved && <span role="status" className="goal-meta">{t('工作目录已保存', 'Working directories saved')}</span>}
    </div></CollapsibleContent>
  </Collapsible>
}
