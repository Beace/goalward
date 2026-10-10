import { uiFontStack } from '@/lib/fonts'
import { useI18n } from '@/i18n'
import { useAppearanceTheme } from '@/hooks/use-appearance-theme'
import { useAppearanceSettings } from '@/hooks/use-appearance-settings'
import { useAppUpdate } from '@/hooks/use-app-update'
import { appearancePreferences } from '@/lib/appearance'
import { version as appVersion } from '../package.json'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Activity, FileText, CircleHelp, Command, Download, Folder, FolderOpen, GitBranch, LayoutPanelLeft, Plus, Search, Settings2, Terminal } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { notify, Toaster } from '@/components/ui/sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import { InspectorTabs } from '@/components/InspectorTabs'
import { InspectorLayout } from '@/components/InspectorLayout'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Workbench } from '@/components/Workbench'
import { ArtifactPreview } from '@/components/ArtifactPreview'
import { artifactFromLink, getTaskArtifacts, type Artifact } from '@/lib/artifacts'
import { Status } from '@/components/Status'
import { RuntimeLogo } from '@/components/RuntimeLogo'
import { useAppState } from '@/hooks/use-app-state'
import { useEnvironmentDiscovery } from '@/hooks/use-environment-discovery'
import { canConfigureTask, discoveryManagedIds, hasStarterSettings, mergeLocalDiscovery } from '@/lib/onboarding'
import { applyRuntimeEvent, buildPrompt, createTask, getTaskStatus } from '@/lib/domain'
import { validateRuntimePermissions } from '@/lib/runtime-permissions'
import { resolveReasoningEffort } from '@/lib/reasoning'
import { reusableSession } from '@/lib/runtime-session'
import { chooseDirectory, exportTask, isDesktop, startRun, stopRun } from '@/lib/bridge'
import type { AppState, OnboardingState, Run, RunMember, Settings, StartRequest, Task } from '@/lib/types'
import { WorkspaceNavigation, type WorkspacePage } from '@/components/WorkspaceNavigation'
import { WorkspaceLayout } from '@/components/WorkspaceLayout'
import { TasksPage } from '@/components/TasksPage'
import { ActivityPage } from '@/components/ActivityPage'
import { DashboardPage } from '@/components/DashboardPage'
import { TaskOperations } from '@/components/TaskOperations'
import { TaskActionButtons, type OpenTaskAction } from '@/components/TaskActionButtons'
import { TaskActionDialogs, type TaskActionSelection } from '@/components/TaskActionDialogs'
import { AgentMemberActions } from '@/components/AgentMemberActions'
import { createWorkspaceTask, assertTaskReady, captureRunContext, contextPrompt, readySteps, validatePlan, isTaskRunning, rollbackControlChange } from '@/lib/workspace'
import { memberFromAgent } from '@/lib/agent-profiles'
import { createDueGoalReview } from '@/lib/goals'
import type { ExecutionStep } from '@/lib/task-types'
import './components/workspace.css'
import { GoalsPage } from '@/components/GoalsPage'
import { WorkspacePending } from '@/components/WorkspacePending'
const AgentsPage = lazy(() => import('@/components/AgentsPage').then(m=>({default:m.AgentsPage})))
const SettingsPage = lazy(() => import('@/components/SettingsPage'))
const SetupPage = lazy(() => import('@/components/SetupPage'))
const TracePanel = lazy(() => import('@/components/TracePanel').then(module => ({ default: module.TracePanel })))

export default function App() {
  const { t, language, setPreference } = useI18n()
  const { state, update, error: storageError, clearError, saved, ensureTaskReady, historyErrors } = useAppState()
  const { saveAppearance, appearanceSaving } = useAppearanceSettings(state?.settings, update)
  useLayoutEffect(() => { if (state) setPreference(state.settings.language ?? 'system') }, [state?.settings.language, Boolean(state), setPreference])
  const appearanceTheme = useAppearanceTheme(state?.settings.theme, Boolean(state))
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--app-font-sans', uiFontStack(state?.settings.fontFamily))
    return () => { document.documentElement.style.removeProperty('--app-font-sans') }
  }, [state?.settings.fontFamily])
  const [page, setPage] = useState<WorkspacePage | 'settings' | 'setup'>('goals')
  const returnPage=useRef<WorkspacePage>('goals')
  const taskListWidth = useRef(240)
  const goalListWidth = useRef(window.innerWidth <= 1400 ? 186 : 210)
  const sidebarWidth = useRef(window.innerWidth <= 1300 ? 200 : 224)
  const discovery = useEnvironmentDiscovery()
  const initialScan = useRef(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [settingsTarget, setSettingsTarget] = useState<{ runtimeId?: string; category?: 'runtimes' | 'models' | 'updates'; hint?: boolean; request?: number }>({})
  const [settingsDraftDirty, setSettingsDraftDirty] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDirectory, setNewDirectory] = useState('')
  const [newMode, setNewMode] = useState<'solo' | 'team'>('solo')
  const [newError, setNewError] = useState('')
  const [taskAction, setTaskAction] = useState<TaskActionSelection | null>(null)
  const [inspectorTab, setInspectorTab] = useState('trace')
  const [inspectorTabs, setInspectorTabs] = useState(['trace', 'preview'])
  function activateInspectorTab(id: string) {
    setInspectorTabs(tabs => tabs.includes(id) ? tabs : [...tabs, id])
    setInspectorTab(id)
  }
  const [previewSelection, setPreviewSelection] = useState<{ taskId: string; artifact: Artifact }>()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [smallWindow, setSmallWindow] = useState(window.innerWidth < 1280)
  const smallWindowRef = useRef(smallWindow)
  const [runId, setRunId] = useState('')
  const [newGoalId, setNewGoalId] = useState('none')
  const [newAgentId, setNewAgentId] = useState('default')
  const [newParentId, setNewParentId] = useState<string>()
  const [newAcceptance, setNewAcceptance] = useState('')
  const [newExecutor, setNewExecutor] = useState<'agent'|'human'>('agent')
  const [selectedAgentId, setSelectedAgentId] = useState<string>()
  const [traceMemberId, setTraceMemberId] = useState<string>()
  const [dispatchEpoch, setDispatchEpoch] = useState(0)
  const dispatching = useRef(false)
  const controlWrites = useRef(0)
  const cancelled = useRef(new Set<string>())
  const task = state?.tasks.find(t => t.id === state.activeTaskId) ?? state?.tasks[0]
  useEffect(() => {
    if ((page === 'workbench' || page === 'tasks') && task?.historyPending) void ensureTaskReady(task.id).catch(() => {})
  }, [page, task?.id, task?.historyPending, ensureTaskReady])
  const artifacts = useMemo(() => (page === 'workbench' || page === 'tasks') && task ? getTaskArtifacts(task) : [], [page, task?.id, task?.messages, task?.events, task?.runs, task?.directory, task?.artifacts, language])
  const previewArtifact = previewSelection?.taskId === task?.id ? (artifacts.find(item => item.id === previewSelection?.artifact.id) ?? previewSelection?.artifact) : undefined
  const openArtifactPreview = (artifact: Artifact) => { if (task) setPreviewSelection({ taskId: task.id, artifact }); activateInspectorTab('preview'); setInspectorOpen(true) }
  async function recordSavedArtifact(artifact: Artifact, path: string) {
    const taskId = task?.id
    if (!taskId) throw new Error(t('任务不存在', 'Task not found'))
    const reference: Artifact = { ...artifact, content: undefined, path, directory: path.slice(0, path.lastIndexOf('/')) || '/', name: path.split('/').at(-1) || artifact.name, source: 'saved' }
    await update(state => ({ ...state, tasks: state.tasks.map(task => task.id === taskId ? { ...task, artifacts: [...(task.artifacts ?? []).filter(item => item.id !== reference.id), reference] } : task) }))
  }
  const activeCount = state?.tasks.flatMap(t => t.runs).flatMap(r => r.members).filter(m => m.status === 'running').length ?? 0
  const applyingUpdateBlocked = Boolean(state?.tasks.some(task => isTaskRunning(task) || task.orchestration === 'running'))
  const appUpdate = useAppUpdate({
    ready: Boolean(state),
    canApplyUpdate: () => Boolean(state && saved && !appearanceSaving && !settingsDraftDirty && !applyingUpdateBlocked && !dispatching.current && controlWrites.current === 0),
    onAvailable: info => notify.info(t(`Goalward ${info.version} 已可更新`, `Goalward ${info.version} is available`), {
      action: { label: t('查看更新', 'View update'), onClick: () => openSettings(undefined, 'updates') },
    }),
  })
  const needsConfiguration = Boolean(state && !state.settings.runtimes.some(canConfigureTask))
  const setupVisible = page === 'setup' || Boolean(isDesktop && state && !state.onboarding && page !== 'settings')
  useEffect(() => {
    if (isDesktop && state && !state.onboarding && !initialScan.current) {
      initialScan.current = true
      setPage('setup')
      void discovery.scan()
    }
  }, [state, discovery.scan])
  const openDiscovery = useCallback(() => {
    setSetupError(''); setPage('setup'); setCommandOpen(false)
    void discovery.scan()
  }, [discovery.scan])
  function openSettings(runtimeId?: string, category: 'runtimes' | 'models' | 'updates' = 'runtimes', hint = false) {
    if(page!=='settings'&&page!=='setup')returnPage.current=page
    setSettingsTarget(current => ({ runtimeId, category, hint, request: (current.request ?? 0) + 1 })); setPage('settings'); setCommandOpen(false)
  }
  const openNew = useCallback(() => {
    setNewGoalId('none'); setNewAgentId('default'); setNewParentId(undefined); setNewAcceptance(''); setNewExecutor('agent');
    setNewTitle(''); setNewDirectory(state?.settings.defaultDirectory ?? ''); setNewMode(state?.settings.defaultMode ?? 'solo'); setNewError(''); setNewOpen(true)
  }, [state?.settings, needsConfiguration, openDiscovery])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!state || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      if (taskAction && ['k', 'n', ','].includes(e.key.toLowerCase())) { e.preventDefault(); return }
      if (setupVisible) { if (['k', 'n', ','].includes(e.key.toLowerCase())) e.preventDefault(); return }
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); setCommandOpen(o => !o) }
      if (e.key.toLowerCase() === 'n' && page !== 'settings') { e.preventDefault(); openNew() }
      if (e.key === ',' && page !== 'settings') { e.preventDefault(); openSettings() }
    }
    const resize = () => {
      const small = window.innerWidth < 1280
      if (small && !smallWindowRef.current) setInspectorOpen(false)
      smallWindowRef.current = small
      setSmallWindow(small)
    }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', resize) }
  }, [!!state, openNew, page, setupVisible, taskAction])

  useEffect(() => {
    if (state && storageError) notify.error(storageError, { onDismiss: clearError, onAutoClose: clearError })
  }, [!!state, storageError])
  const report = (e: unknown) => notify.error(String(e).replace('Error: ', ''))
  async function finishSetup(outcome: OnboardingState['outcome'], runtimeIds: string[] = [], defaultRuntimeId = '') {
    if (!state || setupBusy) return false
    setSetupBusy(true); setSetupError('')
    let previous = { settings: state.settings, onboarding: state.onboarding }
    try {
      await update(s => {
        previous = { settings: s.settings, onboarding: s.onboarding }
        const result = discovery.report ?? { scannedAt: new Date().toISOString(), runtimes: [] }
        const managed = new Set(discoveryManagedIds(s.settings, s.onboarding?.managedRuntimes))
        const settings = outcome === 'imported' || hasStarterSettings(s)
          ? mergeLocalDiscovery(s.settings, result, runtimeIds, defaultRuntimeId, hasStarterSettings(s), s.onboarding?.managedRuntimes) : s.settings
        return { ...s,
          settings,
          onboarding: { version: 1, completedAt: new Date().toISOString(), outcome,
            managedRuntimes: settings.runtimes.filter(runtime => managed.has(runtime.id) || !s.settings.runtimes.some(previous => previous.id === runtime.id)),
            ...(discovery.report ? { lastScan: discovery.report } : s.onboarding?.lastScan ? { lastScan: s.onboarding.lastScan } : {}) },
        }
      })
      return true
    } catch (error) {
      await update(s => ({ ...s, ...previous })).catch(() => {})
      setSetupError(t(`配置未能保存：${String(error).replace('Error: ', '')}。请重试，检测结果已保留。`, `Could not save configuration: ${String(error).replace('Error: ', '')}. Please retry; the scan results are preserved.`))
      return false
    } finally { setSetupBusy(false) }
  }
  async function importDiscovery(runtimeIds: string[], defaultRuntimeId: string) {
    if (!discovery.report || !discovery.report.runtimes.some(runtime => runtimeIds.includes(runtime.id) && runtime.probe.found)) {
      setSetupError(t('请选择至少一个已找到的 Runtime，或进入手动配置。', 'Select at least one detected runtime or configure one manually.')); return
    }
    if (await finishSetup('imported', runtimeIds, defaultRuntimeId)) setPage('goals')
  }
  async function configureFromSetup(runtimeId?: string, category: 'runtimes' | 'models' = 'runtimes') {
    const found = runtimeId && discovery.report?.runtimes.some(runtime => runtime.id === runtimeId && runtime.probe.found)
    if (await finishSetup(found ? 'imported' : 'manual', found ? [runtimeId] : [], found ? runtimeId : '')) openSettings(runtimeId, category, true)
  }
  async function laterSetup() {
    if (state?.onboarding || await finishSetup('deferred')) setPage('goals')
  }
  async function saveSettings(settings: Settings) {
    if (!state) return
    let previous = { settings: state.settings, onboarding: state.onboarding }
    try {
      await update(s => {
        previous = { settings: s.settings, onboarding: s.onboarding }
        return { ...s, settings: { ...settings, ...appearancePreferences(s.settings) }, onboarding: s.onboarding && settings.runtimes.some(canConfigureTask) ? { ...s.onboarding, outcome: 'configured' } : s.onboarding }
      })
    } catch (error) { await update(s => ({ ...s, ...previous, settings: { ...previous.settings, ...appearancePreferences(s.settings) } })).catch(() => {}); throw error }
  }
  const openTaskAction: OpenTaskAction = (kind, target, trigger) => setTaskAction({ kind, task: target, trigger })
  const taskDeleted = () => { clearError(); setRunId(''); setTraceMemberId(undefined); setPage('tasks'); notify.success(t('任务已删除', 'Task deleted')) }
  const changeTask = (changed: Task) => { void update(s => ({ ...s, tasks: s.tasks.map(t => t.id === changed.id ? { ...t, members: changed.members, mode: changed.mode } : t) })).catch(report) }
  function selectTask(id: string, selectedRun = '', memberId?: string) { if (id !== task?.id) { setPreviewSelection(undefined); setInspectorTabs(['trace', 'preview']); setInspectorTab('trace') }; if (memberId) activateInspectorTab('trace'); void update(s => s.activeTaskId === id ? s : { ...s, activeTaskId: id }).catch(report); setRunId(selectedRun); setTraceMemberId(memberId); if(memberId) setInspectorOpen(true); setPage('workbench'); setCommandOpen(false) }
  function openGoal(id: string) { void update(s=>s.activeGoalId===id?s:{...s,activeGoalId:id}).catch(report);setPage('goals') }
  function openAgent(id?: string) { setSelectedAgentId(id);setPage('agents') }
  function newFromGoal(goalId: string, title?: string) { openNew();setNewGoalId(goalId); if(title)setNewTitle(title) }
  function newFromAgent(agentId: string, goalId?: string) { openNew();setNewAgentId(agentId);setNewGoalId(goalId??'none') }
  function newSubtask(parent:Task) { openNew();setNewParentId(parent.id);setNewGoalId(parent.goalId??'none');setNewDirectory(parent.directory) }
  async function create() {
    if (!state) return
    try {
      let created = ''
      await update(s=>{
        const profile=s.agents.find(a=>a.id===newAgentId)
        const parent=s.tasks.find(t=>t.id===newParentId)
        if(newParentId&&!parent)throw new Error(t('父任务已不存在，请重新创建任务', 'The parent task no longer exists. Create the task again.'))
        const next=createWorkspaceTask(s.settings,{title:newTitle,directory:newDirectory,mode:newMode,goalId:parent?.goalId??(newGoalId==='none'?undefined:newGoalId),parentTaskId:parent?.id,acceptance:newAcceptance,executor:newExecutor,members:newExecutor==='human'?[]:profile?[memberFromAgent(profile)]:undefined})
        created=next.id
        return {...s,tasks:[next,...s.tasks],activeTaskId:next.id}
      })
      setNewOpen(false);selectTask(created)
    } catch (e) { setNewError(String(e).replace('Error: ', '')) }
  }
  async function sendForTask(taskId: string, prompt: string, recipient: string, step?: ExecutionStep) {
    if (!state) return
    if (!isDesktop) throw new Error(t('请打开 macOS 应用启动本机 Agent；这里是浏览器预览。', 'Open the macOS app to run a local agent; this is a browser preview.'))
    if (dispatching.current) throw new Error(t('正在启动上一批次，请稍候。', 'The previous run is still starting. Please wait.'))
    dispatching.current = true
    const requests: StartRequest[] = []
    const id = crypto.randomUUID()
    let reserved = false
    const fail = async (memberId: string, text: string) => update(s => applyRuntimeEvent(s, { id: crypto.randomUUID(), taskId, runId: id, memberId, timestamp: new Date().toISOString(), kind: 'failed', text }))
    try {
      await ensureTaskReady(taskId)
      // Validate and reserve against the latest state after history recovery.
      await update(s => {
        const current = s.tasks.find(t => t.id === taskId)
        if (!current || current.demo) throw new Error(t('请先创建真实任务', 'Create a real task first'))
        assertTaskReady(s,current)
        if (step) { validatePlan(current); if(!readySteps(current).some(entry=>entry.id===step.id)) throw new Error(t('步骤依赖尚未完成或已经开始执行', 'Step dependencies are incomplete or the step has already started')) }
        if (!current.directory.trim()) throw new Error(t('任务缺少工作目录', 'The task has no working directory'))
        if ((!step || current.orchestration !== 'running') && current.runs.some(r => r.members.some(m => m.status === 'running'))) throw new Error(t('请等待当前批次结束，或停止执行后再发送。', 'Wait for the current run to finish, or stop it before sending.'))
        const selected = step ? current.members.filter(m=>step.memberIds.includes(m.id)) : current.mode === 'solo' ? current.members.slice(0, 1) : recipient === 'all' ? current.members : current.members.filter(m => m.id === recipient)
        const count = s.tasks.flatMap(t => t.runs).flatMap(r => r.members).filter(m => m.status === 'running').length
        if (!selected.length) throw new Error(t('请选择消息接收者', 'Select a message recipient'))
        if (selected.length + count > s.settings.maxParallel) throw new Error(t(`同时运行上限为 ${s.settings.maxParallel} 个成员，请等待其他任务完成。`, `Up to ${s.settings.maxParallel} members can run at once. Wait for another task to finish.`))
        const members: RunMember[] = selected.map(member => {
          const runtime = s.settings.runtimes.find(r => r.id === member.runtimeId && r.enabled)
          if (!runtime) throw new Error(t(`${member.name} 的 Runtime 已禁用，请在设置中启用。`, `The runtime for ${member.name} is disabled. Enable it in Settings.`))
          const permissionError = validateRuntimePermissions(runtime)
          if (permissionError) throw new Error(`${runtime.name}：${permissionError}`)
          if (runtime.adapter === 'generic' && !runtime.args.some(a => a.includes('{prompt}'))) throw new Error(t(`${runtime.name} 需要在设置中配置含 {prompt} 的启动参数。`, `${runtime.name} needs a launch argument containing {prompt} in Settings.`))
          if (member.modelId && !s.settings.models.some(m => m.enabled && m.modelId === member.modelId && m.runtimeIds.includes(runtime.id))) throw new Error(t(`${member.name} 的模型已禁用或未绑定此 Runtime，请重新选择模型。`, `${member.name}'s model is disabled or not linked to this runtime. Choose another model.`))
          const effectiveReasoningEffort = resolveReasoningEffort(member, runtime, s.settings.models)
          return { ...member, runtime: structuredClone(runtime), model: member.modelId, effectiveReasoningEffort, sessionId: reusableSession(current, member, runtime), status: 'running' }
        })
        const context=captureRunContext(s,current,step)
        const run: Run = { id, createdAt: new Date().toISOString(), directory: current.directory, prompt, members, context, stepId:step?.id }
        requests.push(...members.map(member => ({ taskId: current.id, runId: id, memberId: member.id, runtime: member.runtime, model: member.model, reasoningEffort: member.effectiveReasoningEffort, sessionId: member.sessionId, directory: run.directory, prompt: buildPrompt(current, prompt, member, Boolean(member.sessionId))+contextPrompt(context) })))
        reserved = true
        return { ...s, tasks: s.tasks.map(t => t.id !== current.id ? t : { ...t, businessStatus:'in_progress', plan:step?t.plan?.map(entry=>entry.id===step.id?{...entry,status:'running',runId:id}:entry):t.plan, runs: [...t.runs, run], messages: [...t.messages, { id: crypto.randomUUID(), role: 'user', text: prompt, createdAt: run.createdAt, runId: id }] }) }
      })
      if(taskId===state.activeTaskId) setRunId(id)
      await Promise.all(requests.map(async request => {
        try {
          if (cancelled.current.has(id)) {
            await update(s => applyRuntimeEvent(s, { id: crypto.randomUUID(), taskId, runId: id, memberId: request.memberId, timestamp: new Date().toISOString(), kind: 'stopped', text: t('启动前已取消，未创建进程。', 'Canceled before launch; no process was created.') }))
            return
          }
          await startRun(request)
        }
        catch (e) { await fail(request.memberId, t(`启动失败：${String(e)}`, `Failed to start: ${String(e)}`)).catch(report); report(t(`${request.runtime.name} 启动失败：${String(e)}`, `Failed to start ${request.runtime.name}: ${String(e)}`)); return }
        // A failed stop request does not prove the already-started process exited.
        if (cancelled.current.has(id)) await stopRun(id, request.memberId).catch(e=>report(t(`停止请求失败，进程状态等待确认：${String(e)}`, `Stop request failed; process status is pending confirmation: ${String(e)}`)))
      }))
    } catch (e) {
      if (reserved) await Promise.all(requests.map(request => fail(request.memberId, t('未启动进程：执行配置保存失败。', 'Process not started: could not save run configuration.')).catch(report)))
      throw e
    } finally { dispatching.current = false; cancelled.current.delete(id); setDispatchEpoch(value=>value+1) }
  }
  const send=(prompt:string,recipient:string)=>task?sendForTask(task.id,prompt,recipient):Promise.resolve()
  const runStep=(target:Task,step:ExecutionStep)=>sendForTask(target.id,[step.title,step.instructions,t(`预期输出：${step.expectedOutput}`, `Expected output: ${step.expectedOutput}`),t(`前置步骤结果：${(target.plan??[]).filter(s=>step.dependsOn.includes(s.id)).map(s=>s.title+': '+(s.output??'')).join('\n')}`, `Previous step results: ${(target.plan??[]).filter(s=>step.dependsOn.includes(s.id)).map(s=>s.title+': '+(s.output??'')).join('\n')}`)].join('\n\n'),'all',step)
  async function stopExecution(taskId:string,id:string) {
    cancelled.current.add(id)
    const results=await Promise.allSettled([update(s=>({...s,tasks:s.tasks.map(t=>t.id===taskId?{...t,orchestration:'stopped'}:t)})),stopRun(id)])
    const errors=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected').map(r=>String(r.reason))
    if(errors.length)throw new Error(errors.join('；'))
  }
  function stop() { task?.runs.filter(r=>r.members.some(m=>m.status==='running')).forEach(r=>void stopExecution(task.id,r.id).catch(report)) }
  async function changeControl(fn:(state:AppState)=>AppState) {
    controlWrites.current++
    let before:AppState|undefined,applied:AppState|undefined
    try { await update(s=>{before=s;applied=fn(s);return applied}) }
    catch(error) {
      if(before&&applied) await update(s=>rollbackControlChange(s,before!,applied!)).catch(report)
      throw error
    } finally {controlWrites.current--;setDispatchEpoch(value=>value+1)}
  }
  async function orchestrate(target:Task,start:boolean) {
    if(start&&!isDesktop)throw new Error(t('请在 macOS 应用中运行执行编排。', 'Run orchestration in the macOS app.'))
    if(start)await ensureTaskReady(target.id)
    const ids:string[]=[]
    const persistence=(start?changeControl:update)(s=>({...s,tasks:s.tasks.map(currentTask=>{if(currentTask.id!==target.id)return currentTask;if(start){assertTaskReady(s,currentTask);validatePlan(currentTask);if(!currentTask.plan?.length)throw new Error(t('请先添加执行步骤', 'Add execution steps first'));if(currentTask.plan.some(step=>step.kind==='agent'&&step.memberIds.length>s.settings.maxParallel))throw new Error(t('步骤成员数超过并行上限', 'The step has more members than the parallel limit'))}else{for(const run of currentTask.runs.filter(r=>r.members.some(m=>m.status==='running'))){ids.push(run.id);cancelled.current.add(run.id)}}return {...currentTask,orchestration:start?'running':'stopped'}})}))
    const results=await Promise.allSettled([persistence,...ids.map(id=>stopRun(id))])
    const errors=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected').map(r=>String(r.reason))
    if(errors.length)throw new Error(errors.join('；'))
  }
  // Only explicit user-started plans dispatch work. Reload migration stops plans;
  // independent ready steps obey the same persisted global reservations as chat.
  useEffect(()=>{
    if(!state||!isDesktop||dispatching.current||controlWrites.current||!saved)return
    const plans=state.tasks.filter(t=>t.orchestration==='running'&&!t.historyPending)
    for(const current of plans){
      if(current.plan?.length&&current.plan.every(step=>step.status==='done'||step.status==='failed'&&step.failurePolicy==='continue')){void update(s=>({...s,tasks:s.tasks.map(t=>t.id===current.id?{...t,orchestration:'completed'}:t)})).catch(report);return}
      const next=readySteps(current).find(step=>step.kind==='agent'&&step.memberIds.length+activeCount<=state.settings.maxParallel)
      if(next){void runStep(current,next).catch(e=>{report(e);void update(s=>({...s,tasks:s.tasks.map(t=>t.id===current.id?{...t,orchestration:'stopped'}:t)})).catch(report)});return}
    }
  },[state,dispatchEpoch,saved])
  useEffect(()=>{
    if(!state)return
    const check=()=>{void update(s=>{const goals=s.goals.map(g=>createDueGoalReview(g));return goals.every((g,i)=>g===s.goals[i])?s:{...s,goals}}).catch(report)}
    check();const timer=setInterval(check,30000);return()=>clearInterval(timer)
  },[!!state,update])
  function doExport() { if (task) void ensureTaskReady(task.id).then(exportTask).then(path => notify.success(t(`已导出：${path}`, `Exported: ${path}`))).catch(report) }
  function duplicate() { if (!task) return; openNew(); setNewTitle(task.title); setNewMode(task.mode); setNewDirectory(state?.settings.defaultDirectory ?? '') }
  const chosenRun = task?.runs.find(r => r.id === runId) ?? task?.runs.at(-1)
  return <TooltipProvider delayDuration={300}><div className="app-shell">
    <header className={`titlebar ${isDesktop ? 'native-titlebar' : ''}`} data-tauri-drag-region onDoubleClick={() => { if (isDesktop) void getCurrentWindow().toggleMaximize().catch(report) }}>
      {!isDesktop && <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>}
      <Button variant="ghost" className="title-command" disabled={!state || setupVisible} onClick={() => setCommandOpen(true)}><Search size={13} /><span>{setupVisible ? t('Goalward / 本机环境检测', 'Goalward / Local environment scan') : t('工作空间：Goalward / 全局命令', 'Workspace: Goalward / Command palette')}</span><kbd>⌘ K</kbd></Button><span className="title-app-name" data-tauri-drag-region>Goalward <span>Desktop</span></span>
    </header>
    {state && setupVisible ? <Suspense fallback={<div className="app-loading">{t('正在打开本机环境检测…', 'Opening local environment scan…')}</div>}><SetupPage report={discovery.report} scanning={discovery.scanning} error={setupError || discovery.error} busy={setupBusy} settings={state.settings} mode={state.onboarding ? 'rescan' : 'first-run'} onRescan={() => { setSetupError(''); void discovery.scan() }} onImport={importDiscovery} onConfigure={(runtimeId, category) => { void configureFromSetup(runtimeId, category) }} onLater={laterSetup} /></Suspense> : state && page === 'settings' ? <Suspense fallback={<div className="app-loading">{t('正在打开设置…', 'Opening Settings…')}</div>}><SettingsPage settings={state.settings} onSave={saveSettings} onAppearanceChange={saveAppearance} appearanceSaving={appearanceSaving} onBack={() => setPage(returnPage.current)} onExport={doExport} activeCount={activeCount} initialCategory={settingsTarget.category} initialRuntimeId={settingsTarget.runtimeId} navigationKey={settingsTarget.request} appUpdate={appUpdate} onDraftChange={setSettingsDraftDirty} dataSaving={!saved} tasksBusy={applyingUpdateBlocked} setupHint={settingsTarget.hint || needsConfiguration} onDiscover={openDiscovery} discoveryReport={state.onboarding?.lastScan} /></Suspense> : <>
    {state && needsConfiguration && <div role="status" className="flex shrink-0 items-center gap-3 border-b border-border bg-accent px-4 py-2 text-xs"><Terminal size={14} /><span className="flex-1">{t('目标和任务可先记录；启动 Agent 前请配置本地 Runtime。', 'You can record goals and tasks now; configure a local runtime before starting an agent.')}</span><Button size="sm" variant="outline" onClick={openDiscovery}>{t('检测本机环境', 'Scan local environment')}</Button><Button size="sm" onClick={() => openSettings(undefined, 'runtimes', true)}>{t('手动配置', 'Configure manually')}</Button></div>}
    <WorkspaceLayout sidebarWidth={sidebarWidth} navigation={<WorkspaceNavigation state={state} page={page} onPage={setPage} onNewTask={openNew} onSearch={()=>setCommandOpen(true)} onSettings={openSettings} onTask={selectTask}/>}>
      {!state ? <WorkspacePending page={page} error={storageError} goalListWidth={goalListWidth} /> : page==='dashboard'?<DashboardPage state={state} onGoal={openGoal} onTask={selectTask} onGoals={()=>setPage('goals')} onTasks={()=>setPage('tasks')} onNewTask={openNew}/>:page==='goals'?<GoalsPage goalListWidth={goalListWidth} state={state} onChange={update} onCreateTask={newFromGoal} onOpenTask={selectTask} onOpenAgent={openAgent} selectedGoalId={state.activeGoalId} onSelectGoal={id=>void update(s=>({...s,activeGoalId:id})).catch(report)}/>:page==='agents'?<Suspense fallback={<div className="app-loading">{t('正在打开 Agents…', 'Opening Agents…')}</div>}><AgentsPage state={state} onChange={update} onCreateTask={newFromAgent} onOpenTask={selectTask} onSettings={openSettings} initialAgentId={selectedAgentId}/></Suspense>:page==='running'?<ActivityPage state={state} onTask={selectTask} onStop={(taskId,runId)=>void stopExecution(taskId,runId).catch(report)}/>: <TasksPage state={state} selectedTaskId={task?.id} onTask={selectTask} onCreate={openNew} rememberedWidth={taskListWidth}>{task ? <InspectorLayout open={inspectorOpen} compact={smallWindow} onOpenChange={setInspectorOpen} inspector={<InspectorTabs key={task.id} value={inspectorTab} onValueChange={setInspectorTab} onClose={() => setInspectorOpen(false)} onCloseTab={id => setInspectorTabs(tabs => tabs.filter(tab => tab !== id))} tabs={[
        { id: 'trace', label: t('执行过程', 'Execution trace'), icon: <Activity size={14}/>, actions: <Button variant="ghost" size="icon-sm" title={t('导出聊天与执行过程', 'Export chat and execution trace')} aria-label={t('导出聊天与执行过程', 'Export chat and execution trace')} onClick={doExport}><Download/></Button>, content: task.historyPending ? (historyErrors[task.id]
          ? <div className="flex min-h-10 items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="alert"><span className="min-w-0 flex-1 break-words">{t(`历史记录加载失败：${historyErrors[task.id]}`, `Could not load history: ${historyErrors[task.id]}`)}</span><Button variant="outline" size="sm" onClick={() => { void ensureTaskReady(task.id).catch(() => {}) }}>{t('重试', 'Retry')}</Button></div>
          : <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-6 text-xs text-muted-foreground" role="status"><Spinner className="size-5" aria-hidden="true"/><span>{t('加载执行记录', 'Loading execution history')}</span></div>) : inspectorOpen && inspectorTab === 'trace' ? <Suspense fallback={<div className="inspector-tab-empty" role="status">{t('加载执行过程…', 'Loading execution trace…')}</div>}><TracePanel key={task.id + (chosenRun?.id ?? '')}  embedded task={task} run={chosenRun} initialMemberId={traceMemberId} onClose={() => setInspectorOpen(false)} onExport={doExport}/></Suspense> : null },
        { id: 'preview', label: t('产物预览', 'Artifact preview'), icon: <FileText size={14}/>, content: previewArtifact ? <ArtifactPreview key={previewArtifact.id} artifact={previewArtifact} onOpenLink={href => {
          const base = previewArtifact.path?.includes('/') ? previewArtifact.path.slice(0, previewArtifact.path.lastIndexOf('/')) : ''
          const directory = base.startsWith('/') ? base : base ? `${previewArtifact.directory}/${base}` : previewArtifact.directory
          const linked = artifactFromLink(href, { ...previewArtifact, directory }, task.id)
          if (linked) openArtifactPreview({ ...linked, directory: previewArtifact.directory })
        }} onSaved={recordSavedArtifact}/> : <div className="inspector-tab-empty"><FileText size={24}/><p>{t('选择产物以预览', 'Select an artifact to preview')}</p><span>{t('点击“产物”中的文件，或对话中的文件按钮。', 'Click a file in Artifacts or a file button in the conversation.')}</span></div> },
      ].filter(tab => inspectorTabs.includes(tab.id))}/>}><Workbench key={task.id} task={task} settings={state.settings} artifacts={artifacts} onOpenArtifact={openArtifactPreview} selectedRunId={runId} onSelectRun={id => { setRunId(id); setPreviewSelection(undefined); activateInspectorTab('trace') }} onChange={changeTask} onSend={send} onStop={stop} onSettings={() => openSettings()} onInspector={() => { activateInspectorTab('trace'); setInspectorOpen(true) }} onToggleInspector={() => { if (!inspectorTabs.length) activateInspectorTab('trace'); setInspectorOpen(o => !o) }} inspectorOpen={inspectorOpen} onDuplicate={duplicate} taskActions={<TaskActionButtons compact task={task} onAction={openTaskAction}/>} goalTitle={state.goals.find(g=>g.id===task.goalId)?.title} onGoal={()=>task.goalId&&openGoal(task.goalId)} agentActions={memberId=><AgentMemberActions task={task} state={state} memberId={memberId} onChange={update} onOpenAgent={openAgent}/>} operations={!task.demo?<TaskOperations key={task.id} task={task} state={state} onChange={changeControl} onEdit={trigger=>openTaskAction('edit',task,trigger)} onGoal={openGoal} onSubtask={newSubtask} onTask={selectTask} onRunStep={step=>runStep(task,step)} onOrchestrate={start=>orchestrate(task,start)}/>:undefined} /></InspectorLayout> : <div className="app-loading"><h1>{t('创建第一项任务', 'Create your first task')}</h1><Button onClick={openNew}><Plus />{t('新建任务', 'New task')}</Button></div>}</TasksPage>}
    </WorkspaceLayout></>}
    <footer className="statusbar"><span><span className={`status-dot ${!isDesktop ? 'preview-dot' : ''}`} />{isDesktop ? t('本地桌面应用', 'Local desktop app') : t('浏览器预览', 'Browser preview')}</span><span>{state ? (activeCount ? t(`${activeCount} 个成员运行中`, `${activeCount} members running`) : t('无运行中的进程', 'No running processes')) : t('运行状态待读取', 'Waiting for run status')}</span><span className="ml-auto">{!state ? (storageError ? t('读取失败', 'Load failed') : t('正在读取本地数据…', 'Loading local data…')) : saved ? t('已保存到本地', 'Saved locally') : t('正在保存…', 'Saving…')}</span><span>v{appVersion}</span></footer>
    {state&&<TaskActionDialogs action={taskAction} state={state} onChange={changeControl} onClose={()=>setTaskAction(null)} onSaved={()=>{clearError();notify.success(t('任务已更新', 'Task updated'))}} onDeleted={taskDeleted} onOpenTask={selectTask}/>}
    <Dialog open={newOpen} onOpenChange={setNewOpen}><DialogContent className="task-dialog"><DialogHeader><DialogTitle>{t('新建任务', 'New task')}</DialogTitle><DialogDescription>{t('先记录要完成的行动，执行时再补齐 Runtime 与工作目录。', 'Record what needs to be done now; add a runtime and working directory before execution.')}</DialogDescription></DialogHeader><div className="new-task-form"><Label htmlFor="task-title">{t('任务目标', 'Task objective')}</Label><Input id="task-title" placeholder={t('例如：为工作台增加全局命令面板', 'For example: add a global command palette')} value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create() }} /><Label>{t('所属目标', 'Goal')}</Label><Select value={newGoalId} disabled={!!newParentId} onValueChange={setNewGoalId}><SelectTrigger aria-label={t('新任务所属目标', 'Goal for new task')}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="none">{t('独立任务', 'Standalone task')}</SelectItem>{state?.goals.map(g=><SelectItem value={g.id} key={g.id}>{g.title}</SelectItem>)}</SelectContent></Select><Label htmlFor="task-acceptance">{t('验收要求（可稍后补充）', 'Acceptance criteria (optional for now)')}</Label><Input id="task-acceptance" value={newAcceptance} onChange={e=>setNewAcceptance(e.target.value)} placeholder={t('怎样确认这项行动已完成', 'How will you know this task is done?')}/><Label>{t('执行者', 'Executor')}</Label><Select value={newExecutor==='human'?'human':newAgentId} onValueChange={v=>{setNewExecutor(v==='human'?'human':'agent');if(v!=='human')setNewAgentId(v)}}><SelectTrigger aria-label={t('新任务执行者', 'Executor for new task')}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="default">{t('临时 Agent · 使用默认 Runtime', 'Temporary agent · Default runtime')}</SelectItem><SelectItem value="human">{t('人工 / 应用外完成', 'Human / completed outside the app')}</SelectItem>{state?.agents.filter(a=>a.enabled).map(a=><SelectItem value={a.id} key={a.id}>{a.name} · v{a.version}</SelectItem>)}</SelectContent></Select><Label htmlFor="task-directory">{t('工作目录（执行前填写）', 'Working directory (required before execution)')}</Label><div className="flex gap-2"><Input id="task-directory" placeholder="/Users/you/Projects/my-project" value={newDirectory} onChange={e => setNewDirectory(e.target.value)} /><Button variant="outline" size="icon-sm" aria-label={t('选择任务工作目录', 'Choose task working directory')} onClick={() => { void chooseDirectory().then(value => { if (value) setNewDirectory(value) }).catch(e => setNewError(String(e).replace('Error: ', ''))) }}><FolderOpen /></Button></div><Label>{t('执行模式', 'Execution mode')}</Label><Select value={newMode} onValueChange={v => setNewMode(v as 'solo' | 'team')}><SelectTrigger aria-label={t('新任务执行模式', 'Execution mode for new task')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="solo">{t('单 Agent · 独立完成任务', 'Single agent · Work independently')}</SelectItem><SelectItem value="team">{t('协作 · 配置多个成员', 'Collaboration · Configure multiple members')}</SelectItem></SelectContent></Select>{newMode === 'team' && <p className="text-muted-foreground text-xs">{t('成员可单独接收指令，也可并行接收同一指令。当前版本共用任务目录。', 'Members can receive separate instructions or work in parallel. They currently share the task directory.')}</p>}{newError && <p role="alert" className="text-destructive text-xs">{newError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setNewOpen(false)}>{t('取消', 'Cancel')}</Button><Button onClick={() => void create()}>{t('创建任务', 'Create task')}</Button></DialogFooter></DialogContent></Dialog>
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen} title={t('全局命令', 'Command palette')} description={t('搜索任务、打开设置或新建任务', 'Search tasks, open Settings, or create a task')}><CommandInput placeholder={t('搜索任务或命令…', 'Search tasks or commands…')} /><CommandList><CommandEmpty>{t('没有找到结果', 'No results found')}</CommandEmpty><CommandGroup heading={t('操作', 'Actions')}><CommandItem onSelect={() => { setCommandOpen(false); if (page === 'settings') { notify.info(t('请先保存或放弃设置更改，再新建任务。', 'Save or discard your Settings changes before creating a task.')); return }; openNew() }}><Plus />{t('新建任务', 'New task')} <kbd className="ml-auto">⌘ N</kbd></CommandItem><CommandItem onSelect={() => { setCommandOpen(false); if (page !== 'settings') openSettings() }}><Settings2 />{t('打开设置', 'Open Settings')}</CommandItem><CommandItem onSelect={() => { setCommandOpen(false); doExport() }}><Download />{t('导出当前任务', 'Export current task')}</CommandItem></CommandGroup>{page !== 'settings' && <><CommandSeparator /><CommandGroup heading={t('任务', 'Tasks')}>{state?.tasks.map(taskItem => <CommandItem key={taskItem.id} value={taskItem.title + taskItem.id} onSelect={() => selectTask(taskItem.id)}><Terminal />{taskItem.title}</CommandItem>)}</CommandGroup></>}</CommandList></CommandDialog>
  </div><Toaster theme={appearanceTheme} /></TooltipProvider>

}
