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
import { useI18n } from '@/i18n'
import type { AppState } from '@/lib/types'
import './goals.css'
import './tasks.css'

export function TasksPage({ state, selectedTaskId, onTask, onCreate, rememberedWidth, children }: {
  state: AppState; selectedTaskId?: string; onTask: (id: string) => void; onCreate: () => void
  rememberedWidth: RefObject<number>; children: ReactNode
}) {
  const { t } = useI18n()
  const statusLabels: typeof taskStatusLabels = {
    todo: t('待开始', 'To do'), in_progress: t('进行中', 'In progress'), blocked: t('受阻', 'Blocked'),
    review: t('待验收', 'In review'), done: t('已完成', 'Done'), cancelled: t('已取消', 'Cancelled'),
  }
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [goal, setGoal] = useState('all')
  const tasks = state.tasks.filter(task => task.title.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || (task.businessStatus ?? 'todo') === filter) && (goal === 'all' || (goal === 'independent' ? !task.goalId : task.goalId === goal)))
  const filtered = !!query || filter !== 'all' || goal !== 'all'
  const clear = () => { setQuery(''); setFilter('all'); setGoal('all') }
  return <div className="tasks-workspace">
    <GoalListLayout idPrefix="task" resizeLabel={t('调整任务列表宽度', 'Resize task list')} contentMinSize="360px" rememberedWidth={rememberedWidth} navigation={<aside className="task-picker" aria-label={t('任务列表', 'Task list')}>
      <header className="task-picker-heading"><h1 data-task-list-heading tabIndex={-1}><ListTodo size={15} />{t('任务', 'Tasks')}</h1><Button size="icon-sm" variant="ghost" aria-label={t('创建任务', 'Create task')} title={t('新建任务', 'New task')} onClick={onCreate}><Plus size={16} /></Button></header>
      <div className="task-picker-tools">
        <div className="task-picker-search"><Search size={14} /><Input aria-label={t('搜索全部任务', 'Search all tasks')} placeholder={t('搜索任务…', 'Search tasks…')} value={query} onChange={event => setQuery(event.target.value)} /></div>
        <Popover><PopoverTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={t('筛选任务', 'Filter tasks')} title={t('筛选任务', 'Filter tasks')} className={filter !== 'all' || goal !== 'all' ? 'bg-accent text-accent-foreground' : ''}><SlidersHorizontal size={14} /></Button></PopoverTrigger>
          <PopoverContent align="start" className="w-64 space-y-3 p-3" aria-label={t('任务筛选', 'Task filters')}>
            <div className="space-y-1.5"><span className="text-xs text-muted-foreground">{t('所属目标', 'Goal')}</span><Select value={goal} onValueChange={setGoal}><SelectTrigger aria-label={t('筛选所属目标', 'Filter by goal')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('全部目标', 'All goals')}</SelectItem><SelectItem value="independent">{t('独立任务', 'Independent tasks')}</SelectItem>{state.goals.map(item => <SelectItem value={item.id} key={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><span className="text-xs text-muted-foreground">{t('业务状态', 'Status')}</span><Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label={t('筛选任务状态', 'Filter by task status')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('全部状态', 'All statuses')}</SelectItem>{Object.entries(statusLabels).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div>
            <Button size="sm" variant="ghost" onClick={clear}>{t('清除筛选', 'Clear filters')}</Button>
          </PopoverContent>
        </Popover>
      </div>
      <div className="task-picker-list">
        {tasks.map(task => {
          const status = getTaskStatus(task)
          const business = task.demo ? t('演示', 'Demo') : statusLabels[task.businessStatus ?? 'todo']
          const owner = task.demo ? t('示例任务', 'Demo task') : state.goals.find(item => item.id === task.goalId)?.title || t('独立任务', 'Independent task')
          const detail = `${task.title}\n${owner} · ${business} · ${task.executor === 'human' ? t('人工任务', 'Human task') : `${task.members.length} Agent`}${task.priority === 'high' ? ` · ${t('高优先级', 'High priority')}` : ''}${status === 'running' ? ` · ${t('执行中', 'Running')}` : status === 'failed' ? ` · ${t('执行失败', 'Run failed')}` : ''}`
          return <Tooltip key={task.id}><TooltipTrigger asChild><Button variant="ghost" className="task-picker-item" aria-label={`${t('打开任务：', 'Open task: ')}${task.title}`} aria-pressed={task.id === selectedTaskId} onClick={() => onTask(task.id)}>
            <span className={`task-picker-dot task-picker-dot-${status}`} aria-hidden="true" /><span className="task-picker-title">{task.parentTaskId && '↳ '}{task.title}</span><small>{business}</small>
          </Button></TooltipTrigger><TooltipContent side="right" className="max-w-80 whitespace-pre-wrap break-words">{detail}</TooltipContent></Tooltip>
        })}
        {!tasks.length && <div className="task-picker-empty"><h2>{state.tasks.length ? t('没有匹配的任务', 'No matching tasks') : t('还没有任务', 'No tasks yet')}</h2>{filtered ? <Button variant="ghost" size="sm" onClick={clear}>{t('清除筛选', 'Clear filters')}</Button> : <p>{t('点击上方 + 创建任务', 'Click + above to create a task')}</p>}</div>}
      </div>
      <footer className="task-picker-footer"><span>{tasks.length} / {state.tasks.length} {t('个任务', 'tasks')}</span>{filtered && <Button variant="ghost" size="sm" onClick={clear}>{t('清除筛选', 'Clear filters')}</Button>}</footer>
    </aside>}>
      {children}
    </GoalListLayout>
  </div>
}
