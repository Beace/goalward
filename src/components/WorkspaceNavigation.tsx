import { useState } from 'react'
import { Activity, Bot, Cpu, LayoutDashboard, ListTodo, Plus, Search, Settings2, Target } from 'lucide-react'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from './ui/collapsible'
import { RuntimeLogo } from './RuntimeLogo'
import productLogo from '../../src-tauri/icons/128x128.png'
import type { AppState } from '@/lib/types'
import { useI18n } from '@/i18n'
export type WorkspacePage = 'dashboard' | 'goals' | 'agents' | 'tasks' | 'running' | 'workbench'
export function WorkspaceNavigation({ state, page, onPage, onNewTask, onSearch, onSettings, onTask, onExplore, onAssistant }: {state:AppState | null; page:string; onPage:(page:WorkspacePage)=>void; onNewTask:()=>void; onSearch:()=>void; onSettings:(id?:string)=>void; onTask:(id:string)=>void; onExplore?:()=>void; onAssistant?:()=>void}) {
 const { t } = useI18n()
 const [runtimesOpen, setRuntimesOpen] = useState(false)
 const count = state?.tasks.flatMap(t=>t.runs).flatMap(r=>r.members).filter(m=>m.status==='running').length
 const links = [{id:'dashboard',label:'Dashboard',icon:LayoutDashboard},{id:'goals',label:t('目标', 'Goals'),icon:Target,count:state?.goals.length},{id:'agents',label:'Agents',icon:Bot,count:state?.agents.length},{id:'tasks',label:t('任务', 'Tasks'),icon:ListTodo,count:state?.tasks.filter(t=>!t.demo&&t.kind!=='goal_assistant').length},{id:'running',label:t('运行中', 'Running'),icon:Activity,count}] as const
 return <nav className="sidebar" aria-label={t('工作空间导航', 'Workspace navigation')}><div className="sidebar-top"><img className="sidebar-product-logo" src={productLogo} width={32} height={32} alt="Goalward" title="Goalward" draggable={false} /><Button variant="outline" className="flex-1" disabled={!state} onClick={onExplore ?? onNewTask}><Plus size={14}/>{onExplore?t('开始一件事', 'Start something'):t('新建任务', 'New task')}</Button><Button variant="outline" size="icon-sm" aria-label={t('全局搜索', 'Global search')} disabled={!state} onClick={onSearch}><Search/></Button></div><div className="workspace-label"><strong>{t('工作空间', 'Workspace')}</strong><span className="ml-auto">{t('本地', 'Local')}</span></div><div className="primary-navigation">{links.map(({id,label,icon:Icon,...link})=><Button key={id} variant="ghost" aria-current={page===id || id==='tasks'&&page==='workbench'?'page':undefined} onClick={()=>onPage(id)}><Icon size={15}/><span>{label}</span>{'count' in link&&link.count!==undefined&&<small>{link.count}</small>}</Button>)}</div><ScrollArea className="flex-1 min-h-0"><div className="task-group-label">{t('最近任务', 'Recent tasks')}</div><div className="task-list">{state?.tasks.filter(task=>task.kind!=='goal_assistant').slice(0,12).map(task=><Button variant="ghost" key={task.id} className={`task-nav-item ${(page==='workbench'||page==='tasks')&&state.activeTaskId===task.id?'task-active':''}`} onClick={()=>onTask(task.id)}><div className="task-nav-top"><span className={`nav-status-dot ${task.runs.some(r=>r.members.some(m=>m.status==='running'))?'nav-running':''}`}/><span title={task.title}>{task.title}</span></div><div className="task-nav-bottom" title={task.demo?t('示例任务', 'Demo task'):state.goals.find(g=>g.id===task.goalId)?.title||t('独立任务', 'Independent task')}>{task.demo?t('示例任务', 'Demo task'):state.goals.find(g=>g.id===task.goalId)?.title||t('独立任务', 'Independent task')}</div></Button>)}</div></ScrollArea>{onAssistant&&<Button className="sidebar-footer-entry goal-assistant-nav" variant="ghost" disabled={!state} onClick={onAssistant}><Bot className="size-4"/><span>{t('目标助手', 'Goal assistant')}</span></Button>}<Collapsible className="runtime-nav" open={runtimesOpen} onOpenChange={setRuntimesOpen}>
   <div className="runtime-nav-header">
     <CollapsibleTrigger asChild>
       <Button disabled={!state} className="sidebar-footer-entry runtime-nav-trigger" variant="ghost" aria-label={runtimesOpen ? t('收起 Runtime 与模型', 'Collapse runtimes and models') : t('展开 Runtime 与模型', 'Expand runtimes and models')} title={runtimesOpen ? t('收起 Runtime 与模型', 'Collapse runtimes and models') : t('展开 Runtime 与模型', 'Expand runtimes and models')}>
         <Cpu className="size-4" />
         <span>{t('Runtime 与模型', 'Runtimes and models')}</span>
         <CollapsibleIndicator className="ml-auto size-3.5" />
       </Button>
     </CollapsibleTrigger>
   </div>
   <CollapsibleContent>
     {state?.settings.runtimes.map(r=><Button key={r.id} variant="ghost" className="runtime-nav-item" disabled={!state} onClick={()=>onSettings(r.id)}><RuntimeLogo runtime={r}/><span>{r.name}</span><span className={r.enabled?'runtime-enabled':''}>{r.enabled?t('已启用', 'Enabled'):t('待配置', 'Needs setup')}</span></Button>)}
   </CollapsibleContent>
 </Collapsible><Button className="sidebar-footer-entry settings-nav" variant="ghost" aria-label={t('设置', 'Settings')} disabled={!state} onClick={()=>onSettings()}><Settings2 className="size-4"/><span>{t('设置', 'Settings')}</span><kbd className="ml-auto">⌘ ,</kbd></Button></nav>
}
