import { useState, type ReactNode, type RefObject } from 'react'
import { ListTodo, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { GoalListLayout } from './GoalListLayout'
import { getTaskStatus } from '@/lib/domain'
import { taskStatusLabels } from '@/lib/workspace'
import type { AppState } from '@/lib/types'
import './goals.css'
import './tasks.css'

export function TasksPage({ state, selectedTaskId, onTask, onCreate, rememberedWidth, children }: {
  state: AppState; selectedTaskId?: string; onTask: (id: string) => void; onCreate: () => void
  rememberedWidth: RefObject<number>; children: ReactNode
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [goal, setGoal] = useState('all')
  const tasks = state.tasks.filter(task => task.title.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || (task.businessStatus ?? 'todo') === filter) && (goal === 'all' || (goal === 'independent' ? !task.goalId : task.goalId === goal)))
  const filtered = !!query || filter !== 'all' || goal !== 'all'
  const clear = () => { setQuery(''); setFilter('all'); setGoal('all') }
  return <div className="tasks-workspace">
    <GoalListLayout idPrefix="task" resizeLabel="调整任务列表宽度" contentMinSize="360px" rememberedWidth={rememberedWidth} navigation={<aside className="task-picker" aria-label="任务列表">
      <header className="task-picker-heading"><h1 data-task-list-heading tabIndex={-1}><ListTodo size={15} />任务</h1><Button size="icon-sm" variant="ghost" aria-label="创建任务" title="新建任务" onClick={onCreate}><Plus size={16} /></Button></header>
      <div className="task-picker-tools">
        <div className="task-picker-search"><Search size={14} /><Input aria-label="搜索全部任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <Popover><PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="筛选任务" title="筛选任务" className={filter !== 'all' || goal !== 'all' ? 'bg-accent text-accent-foreground' : ''}><SlidersHorizontal size={14} /></Button></PopoverTrigger>
          <PopoverContent align="start" className="w-64 space-y-3 p-3" aria-label="任务筛选">
            <div className="space-y-1.5"><span className="text-xs text-muted-foreground">所属目标</span><Select value={goal} onValueChange={setGoal}><SelectTrigger aria-label="筛选所属目标"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部目标</SelectItem><SelectItem value="independent">独立任务</SelectItem>{state.goals.map(item => <SelectItem value={item.id} key={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><span className="text-xs text-muted-foreground">业务状态</span><Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="筛选任务状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(taskStatusLabels).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div>
            <Button size="sm" variant="ghost" onClick={clear}>清除筛选</Button>
          </PopoverContent>
        </Popover>
      </div>
      <div className="task-picker-list">
        {tasks.map(task => {
          const status = getTaskStatus(task)
          const business = task.demo ? '演示' : taskStatusLabels[task.businessStatus ?? 'todo']
          const owner = task.demo ? '示例任务' : state.goals.find(item => item.id === task.goalId)?.title || '独立任务'
          const detail = `${task.title}\n${owner} · ${business} · ${task.executor === 'human' ? '人工任务' : `${task.members.length} Agent`}${task.priority === 'high' ? ' · 高优先级' : ''}${status === 'running' ? ' · 执行中' : status === 'failed' ? ' · 执行失败' : ''}`
          return <Tooltip key={task.id}><TooltipTrigger asChild><Button variant="ghost" className="task-picker-item" aria-label={`打开任务：${task.title}`} aria-pressed={task.id === selectedTaskId} onClick={() => onTask(task.id)}>
            <span className={`task-picker-dot task-picker-dot-${status}`} aria-hidden="true" /><span className="task-picker-title">{task.parentTaskId && '↳ '}{task.title}</span><small>{business}</small>
          </Button></TooltipTrigger><TooltipContent side="right" className="max-w-80 whitespace-pre-wrap break-words">{detail}</TooltipContent></Tooltip>
        })}
        {!tasks.length && <div className="task-picker-empty"><h2>{state.tasks.length ? '没有匹配的任务' : '还没有任务'}</h2>{filtered ? <Button variant="ghost" size="sm" onClick={clear}>清除筛选</Button> : <p>点击上方 + 创建任务</p>}</div>}
      </div>
      <footer className="task-picker-footer"><span>{tasks.length} / {state.tasks.length} 个任务</span>{filtered && <Button variant="ghost" size="sm" onClick={clear}>清除筛选</Button>}</footer>
    </aside>}>
      {children}
    </GoalListLayout>
  </div>
}
