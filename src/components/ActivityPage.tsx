import { useEffect, useState } from 'react'
import { Activity, ArrowUpRight, Square } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { RuntimeLogo } from './RuntimeLogo'
import { Status } from './Status'
import { getRunActivity } from '@/lib/domain'
import { useI18n } from '@/i18n'
import type { AppState } from '@/lib/types'
export function ActivityPage({state,onTask,onStop}:{state:AppState;onTask:(taskId:string,runId?:string,memberId?:string)=>void;onStop:(taskId:string,runId:string)=>void}) {
 const { t } = useI18n()
 const [filter,setFilter]=useState('running'),[now,setNow]=useState(Date.now)
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[])
 const all=state.tasks.filter(t=>!t.demo).flatMap(task=>task.runs.flatMap(run=>run.members.map(member=>({task,run,member})))).reverse()
 const rows=all.filter(({member})=>filter==='all'||filter==='attention'?filter==='all'||['failed','interrupted','stopped'].includes(member.status):member.status==='running')
 const count=all.filter(row=>row.member.status==='running').length
 return <main className="workspace-page"><header className="workspace-page-heading"><div><span className="eyebrow">{t('跨任务执行', 'Across tasks')}</span><h1>{t('运行中', 'Running')} <Badge variant="outline">{count} / {state.settings.maxParallel}</Badge></h1><p>{t('每一行对应一次实际成员调用，权限确认与输出可在任务中查看。', 'Each row represents an agent invocation. Open its task to review approvals and output.')}</p></div><div className="filter-buttons">{[['running',t('运行中', 'Running')],['attention',t('需要关注', 'Needs attention')],['all',t('全部记录', 'All runs')]].map(([id,label])=><Button key={id} variant={filter===id?'secondary':'ghost'} onClick={()=>setFilter(id)}>{label}</Button>)}</div></header><div className="workspace-page-scroll">{rows.map(({task,run,member})=>{
 const activity=getRunActivity(task,run,member.id)
 const elapsed=Math.max(0,Math.floor((member.status==='running'?now:Date.parse(task.events.filter(e=>e.runId===run.id&&e.memberId===member.id).at(-1)?.timestamp??run.createdAt))-Date.parse(run.createdAt))/1000)
 return <article className="activity-row" key={`${run.id}:${member.id}`}><RuntimeLogo runtime={member.runtime} size={22}/><div className="activity-main"><div><strong>{member.name}</strong><Badge variant="outline">{member.runtime.name}</Badge><span>{member.model||t('Runtime 默认模型', 'Runtime default model')}</span></div><Button variant="link" onClick={()=>onTask(task.id,run.id)}>{task.title}</Button><small>{run.context?.goal?.title||state.goals.find(g=>g.id===task.goalId)?.title||t('独立任务', 'Independent task')} · {member.role}</small><p>{activity.summary}</p></div><div className="activity-state"><Status status={member.status}/><small>{elapsed<60?`${Math.floor(elapsed)} ${t('秒', 'sec')}`:`${Math.floor(elapsed/60)} ${t('分', 'min')} ${Math.floor(elapsed%60)} ${t('秒', 'sec')}`}</small><Button size="sm" variant="outline" onClick={()=>onTask(task.id,run.id,member.id)}>{t('定位 Trace', 'Open Trace')} <ArrowUpRight size={12}/></Button>{member.status==='running'&&<Button size="sm" variant="ghost" onClick={()=>onStop(task.id,run.id)}><Square size={11}/>{t('停止本次执行', 'Stop this run')} ({run.members.filter(m=>m.status==='running').length} {t('人', 'agents')})</Button>}</div></article>})}{!rows.length&&<div className="workspace-empty"><Activity size={28}/><h2>{filter==='running'?t('当前没有运行中的 Agent', 'No agents are running'):t('没有对应的执行记录', 'No matching runs')}</h2><p>{t('从任务发送指令后，可在这里查看跨任务活动。', 'Send an instruction from a task to see activity across tasks here.')}</p></div>}</div></main>
}
