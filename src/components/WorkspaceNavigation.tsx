import { useState } from 'react'
import { Activity, Bot, Cpu, LayoutDashboard, ListTodo, Plus, Search, Settings2, Target } from 'lucide-react'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from './ui/collapsible'
import { RuntimeLogo } from './RuntimeLogo'
import productLogo from '../../src-tauri/icons/128x128.png'
import type { AppState } from '@/lib/types'
export type WorkspacePage = 'dashboard' | 'goals' | 'agents' | 'tasks' | 'running' | 'workbench'
export function WorkspaceNavigation({ state, page, onPage, onNewTask, onSearch, onSettings, onTask }: {state:AppState | null; page:string; onPage:(page:WorkspacePage)=>void; onNewTask:()=>void; onSearch:()=>void; onSettings:(id?:string)=>void; onTask:(id:string)=>void}) {
 const [runtimesOpen, setRuntimesOpen] = useState(false)
 const count = state?.tasks.flatMap(t=>t.runs).flatMap(r=>r.members).filter(m=>m.status==='running').length
 const links = [{id:'dashboard',label:'Dashboard',icon:LayoutDashboard},{id:'goals',label:'目标',icon:Target,count:state?.goals.length},{id:'agents',label:'Agents',icon:Bot,count:state?.agents.length},{id:'tasks',label:'任务',icon:ListTodo,count:state?.tasks.filter(t=>!t.demo).length},{id:'running',label:'运行中',icon:Activity,count}] as const
 return <nav className="sidebar" aria-label="工作空间导航"><div className="sidebar-top"><img className="sidebar-product-logo" src={productLogo} width={32} height={32} alt="Goalward" title="Goalward" draggable={false} /><Button variant="outline" className="flex-1" disabled={!state} onClick={onNewTask}><Plus size={14}/>新建任务</Button><Button variant="outline" size="icon-sm" aria-label="全局搜索" disabled={!state} onClick={onSearch}><Search/></Button></div><div className="workspace-label"><strong>工作空间</strong><span className="ml-auto">本地</span></div><div className="primary-navigation">{links.map(({id,label,icon:Icon,...link})=><Button key={id} variant="ghost" aria-current={page===id || id==='tasks'&&page==='workbench'?'page':undefined} onClick={()=>onPage(id)}><Icon size={15}/><span>{label}</span>{'count' in link&&link.count!==undefined&&<small>{link.count}</small>}</Button>)}</div><ScrollArea className="flex-1 min-h-0"><div className="task-group-label">最近任务</div><div className="task-list">{state?.tasks.slice(0,12).map(t=><Button variant="ghost" key={t.id} className={`task-nav-item ${(page==='workbench'||page==='tasks')&&state.activeTaskId===t.id?'task-active':''}`} onClick={()=>onTask(t.id)}><div className="task-nav-top"><span className={`nav-status-dot ${t.runs.some(r=>r.members.some(m=>m.status==='running'))?'nav-running':''}`}/><span title={t.title}>{t.title}</span></div><div className="task-nav-bottom" title={t.demo?'示例任务':state.goals.find(g=>g.id===t.goalId)?.title||'独立任务'}>{t.demo?'示例任务':state.goals.find(g=>g.id===t.goalId)?.title||'独立任务'}</div></Button>)}</div></ScrollArea><Collapsible className="runtime-nav" open={runtimesOpen} onOpenChange={setRuntimesOpen}>
   <div className="runtime-nav-header">
     <CollapsibleTrigger asChild>
       <Button disabled={!state} className="sidebar-footer-entry runtime-nav-trigger" variant="ghost" aria-label={runtimesOpen ? '收起 Runtime 与模型' : '展开 Runtime 与模型'} title={runtimesOpen ? '收起 Runtime 与模型' : '展开 Runtime 与模型'}>
         <Cpu className="size-4" />
         <span>Runtime 与模型</span>
         <CollapsibleIndicator className="ml-auto size-3.5" />
       </Button>
     </CollapsibleTrigger>
   </div>
   <CollapsibleContent>
     {state?.settings.runtimes.map(r=><Button key={r.id} variant="ghost" className="runtime-nav-item" disabled={!state} onClick={()=>onSettings(r.id)}><RuntimeLogo runtime={r}/><span>{r.name}</span><span className={r.enabled?'runtime-enabled':''}>{r.enabled?'已启用':'待配置'}</span></Button>)}
   </CollapsibleContent>
 </Collapsible><Button className="sidebar-footer-entry settings-nav" variant="ghost" aria-label="设置" disabled={!state} onClick={()=>onSettings()}><Settings2 className="size-4"/><span>设置</span><kbd className="ml-auto">⌘ ,</kbd></Button></nav>
}
