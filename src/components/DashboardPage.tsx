import { ArrowRight, CalendarDays, Check, CheckCircle2, Circle, CircleDot, ListChecks, Pause, Target, Users } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { RuntimeLogo } from './RuntimeLogo'
import { getTaskStatus } from '@/lib/domain'
import { taskStatusLabels } from '@/lib/workspace'
import type { Goal, GoalStatus } from '@/lib/goal-types'
import type { AppState, RunStatus, Task } from '@/lib/types'
import './dashboard.css'

const openGoalStatuses = new Set<GoalStatus>(['clarifying', 'active', 'paused', 'maintenance'])
const goalStatusLabels: Record<GoalStatus, string> = {
  clarifying: '待澄清', active: '进行中', paused: '已暂停', achieved: '已完成', maintenance: '持续维护', ended: '已结束',
}

function latestTaskTime(task: Task) {
  const times = [task.createdAt, ...task.messages.map(message => message.createdAt), ...task.runs.map(run => run.createdAt),
    ...task.events.map(event => event.timestamp), ...(task.results ?? []).flatMap(result => [result.createdAt, result.reviewedAt ?? ''])]
    .map(value => Date.parse(value) || 0)
  return Math.max(...times)
}

function completionTime(task: Task) {
  if ((task.businessStatus ?? 'todo') !== 'done') return 0
  const accepted = (task.results ?? []).filter(result => result.verdict === 'accepted')
    .flatMap(result => [result.reviewedAt ?? '', result.createdAt]).map(value => Date.parse(value) || 0)
  const completed = task.events.filter(event => event.kind === 'completed').map(event => Date.parse(event.timestamp) || 0)
  return Math.max(0, ...accepted, ...completed, latestTaskTime(task))
}

function startOfWeek(now: Date) {
  const start = new Date(now)
  const day = (start.getDay() + 6) % 7
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - day)
  return start.getTime()
}

function startOfDay(now: Date) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

function goalProgress(goal: Goal, tasks: Task[]) {
  if (goal.criteria.length) {
    const done = goal.criteria.filter(item => item.status === 'satisfied').length
    return { value: Math.round(done / goal.criteria.length * 100), detail: `${done} / ${goal.criteria.length} 项成功条件已满足` }
  }
  const linked = tasks.filter(task => task.goalId === goal.id)
  if (linked.length) {
    const done = linked.filter(task => (task.businessStatus ?? 'todo') === 'done').length
    return { value: Math.round(done / linked.length * 100), detail: `${done} / ${linked.length} 个关联任务已完成` }
  }
  return { value: null, detail: '尚未记录成功条件或关联任务' }
}

function relativeTime(timestamp: number, now: Date) {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(timestamp)
}

function runState(task: Task): { status: RunStatus | 'idle'; label: string } {
  const execution = getTaskStatus(task)
  if (execution === 'running') return { status: 'running', label: '运行中' }
  if (execution === 'failed') return { status: 'failed', label: '失败' }
  const business = task.businessStatus ?? 'todo'
  if (business === 'done') return { status: 'completed', label: '已完成' }
  if (business === 'blocked') return { status: 'interrupted', label: '已阻塞' }
  return { status: 'idle', label: taskStatusLabels[business] }
}

function GoalStateIcon({ status }: { status: GoalStatus }) {
  if (status === 'paused') return <Pause size={13} />
  if (status === 'maintenance') return <CheckCircle2 size={13} />
  return <CircleDot size={13} />
}

export function DashboardPage({ state, onGoal, onTask, onGoals, onTasks, onNewTask, now = new Date() }: {
  state: AppState; onGoal: (id: string) => void; onTask: (id: string) => void; onGoals: () => void; onTasks: () => void; onNewTask: () => void; now?: Date
}) {
  const tasks = state.tasks.filter(task => !task.demo)
  const openGoals = state.goals.filter(goal => openGoalStatuses.has(goal.status))
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const achievedGoals = state.goals.filter(goal => goal.status === 'achieved')
  const measurableOpenGoals = openGoals.map(goal => goalProgress(goal, tasks)).filter(progress => progress.value !== null)
  const averageProgress = measurableOpenGoals.length
    ? Math.round(measurableOpenGoals.reduce((sum, progress) => sum + (progress.value ?? 0), 0) / measurableOpenGoals.length) : 0
  const goalCompletion = state.goals.length ? Math.round(achievedGoals.length / state.goals.length * 100) : 0
  const weeklyTasks = tasks.filter(task => latestTaskTime(task) >= startOfWeek(now))
  const weeklyDone = weeklyTasks.filter(task => (task.businessStatus ?? 'todo') === 'done')
  const weeklyProgress = weeklyTasks.length ? Math.round(weeklyDone.length / weeklyTasks.length * 100) : 0
  const doneToday = weeklyDone.filter(task => completionTime(task) >= startOfDay(now)).length
  const notStarted = weeklyTasks.filter(task => (task.businessStatus ?? 'todo') === 'todo').length
  const recentTasks = [...tasks].sort((left, right) => latestTaskTime(right) - latestTaskTime(left)).slice(0, 6)

  return <main className="workspace-page dashboard-page">
    <header className="workspace-page-heading dashboard-heading">
      <div><span className="eyebrow">工作空间概览</span><h1>Dashboard</h1><p>聚合目标推进、任务交付和最近的 Agent 执行。</p></div>
      <time dateTime={now.toISOString()}>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now)}</time>
    </header>
    <div className="dashboard-scroll">
      <section className="dashboard-metrics" aria-label="工作空间统计">
        <article className="dashboard-metric metric-active">
          <div className="dashboard-metric-label"><Target size={15} /><span>进行中的目标</span></div>
          <strong>{openGoals.length}</strong>
          <Progress value={averageProgress} aria-label={`进行中目标平均进度 ${averageProgress}%`} />
          <p>{measurableOpenGoals.length ? `平均完成度 ${averageProgress}% · ${measurableOpenGoals.length} 个目标已有可计算进度` : '等待记录成功条件或关联任务'}</p>
        </article>
        <article className="dashboard-metric metric-complete">
          <div className="dashboard-metric-label"><CheckCircle2 size={15} /><span>已完成的目标</span><Badge variant="outline">{goalCompletion}%</Badge></div>
          <strong>{achievedGoals.length}<small>/ {state.goals.length} 总目标</small></strong>
          <Progress value={goalCompletion} aria-label={`目标完成率 ${goalCompletion}%`} />
          <p>{state.goals.length ? `完成率 ${goalCompletion}% · ${state.goals.length - achievedGoals.length} 个目标仍在生命周期中` : '创建目标后，这里会展示整体完成率'}</p>
        </article>
        <article className="dashboard-metric metric-week">
          <div className="dashboard-metric-label"><ListChecks size={15} /><span>本周任务完成</span><CalendarDays size={14} /></div>
          <strong>{weeklyDone.length}<small>/ {weeklyTasks.length}</small></strong>
          <Progress value={weeklyProgress} aria-label={`本周任务完成率 ${weeklyProgress}%`} />
          <p>{weeklyTasks.length ? `${weeklyProgress}% 完成 · 今日完成 ${doneToday} 个 · 未开始 ${notStarted} 个` : '本周还没有真实任务活动'}</p>
        </article>
      </section>

      <section className="dashboard-section" aria-labelledby="active-goals-heading">
        <div className="dashboard-section-heading"><h2 id="active-goals-heading"><CircleDot size={16} />活跃目标</h2><Button variant="ghost" size="sm" onClick={onGoals}>查看全部 <ArrowRight size={13} /></Button></div>
        {openGoals.length ? <div className="dashboard-goal-grid">{openGoals.slice(0, 4).map(goal => {
          const progress = goalProgress(goal, tasks)
          const linked = tasks.filter(task => task.goalId === goal.id)
          const nextTask = [...linked].sort((left, right) => {
            const leftRunning = getTaskStatus(left) === 'running' ? 1 : 0
            const rightRunning = getTaskStatus(right) === 'running' ? 1 : 0
            return rightRunning - leftRunning || latestTaskTime(right) - latestTaskTime(left)
          })[0]
          return <article className={`dashboard-goal-card goal-${goal.status}`} key={goal.id}>
            <div className="dashboard-goal-title"><h3>{goal.title}</h3><strong>{progress.value === null ? '—' : `${progress.value}%`}</strong></div>
            <div className="dashboard-goal-meta"><span><GoalStateIcon status={goal.status} />{goalStatusLabels[goal.status]}</span><i aria-hidden="true" />最后更新：{relativeTime(Date.parse(goal.updatedAt) || 0, now)}</div>
            <Progress value={progress.value ?? 0} aria-label={`${goal.title}：${progress.detail}`} />
            <div className="dashboard-goal-detail"><span><Users size={13} />{linked.length} 个关联任务</span><span>{progress.detail}</span></div>
            <div className="dashboard-goal-actions"><Button variant="outline" onClick={() => onGoal(goal.id)}>查看详情</Button><Button onClick={() => nextTask ? onTask(nextTask.id) : onGoal(goal.id)}>{nextTask ? '继续执行' : '完善目标'}<ArrowRight size={13} /></Button></div>
          </article>
        })}</div> : <div className="dashboard-empty"><Target size={24} /><h3>还没有活跃目标</h3><p>先定义预期结果和成功条件，再把任务关联到目标。</p><Button onClick={onGoals}>创建目标</Button></div>}
      </section>

      <section className="dashboard-section dashboard-recent" aria-labelledby="recent-tasks-heading">
        <div className="dashboard-section-heading"><h2 id="recent-tasks-heading"><ListChecks size={16} />最近执行的任务</h2><Button variant="ghost" size="sm" onClick={onTasks}>查看全部 <ArrowRight size={13} /></Button></div>
        {recentTasks.length ? <div className="dashboard-table"><Table>
          <TableHeader><TableRow><TableHead>任务名</TableHead><TableHead>所属目标</TableHead><TableHead>执行者</TableHead><TableHead>状态</TableHead><TableHead className="dashboard-time-column">最后活动</TableHead></TableRow></TableHeader>
          <TableBody>{recentTasks.map(task => {
            const latestRun = task.runs.at(-1)
            const members = latestRun?.members ?? []
            const runtime = members[0]?.runtime ?? state.settings.runtimes.find(item => item.id === task.members[0]?.runtimeId)
            const status = runState(task)
            const goal = state.goals.find(item => item.id === task.goalId)
            return <TableRow key={task.id}>
              <TableCell><Button variant="link" className="dashboard-task-link" onClick={() => onTask(task.id)}>{task.title}</Button></TableCell>
              <TableCell>{goal ? <Button variant="link" className="dashboard-goal-link" onClick={() => onGoal(goal.id)}>{goal.title}</Button> : <span className="dashboard-muted">独立任务</span>}</TableCell>
              <TableCell><span className="dashboard-runtime">{task.executor === 'human' ? <><Users size={14} />人工</> : <><RuntimeLogo runtime={runtime} runtimeId={task.members[0]?.runtimeId} size={15} />{runtime?.name ?? task.members[0]?.name ?? '未配置'}{members.length > 1 && <small>+{members.length - 1}</small>}</>}</span></TableCell>
              <TableCell><span className={`dashboard-task-status status-${status.status}`}>{status.status === 'completed' ? <Check size={13} /> : status.status === 'running' ? <CircleDot size={13} /> : <Circle size={13} />}{status.label}</span></TableCell>
              <TableCell className="dashboard-time-column"><time dateTime={new Date(latestTaskTime(task)).toISOString()}>{relativeTime(latestTaskTime(task), now)}</time></TableCell>
            </TableRow>
          })}</TableBody>
        </Table></div> : <div className="dashboard-empty dashboard-empty-compact"><ListChecks size={24} /><h3>还没有真实任务</h3><p>示例任务不会计入 Dashboard。创建任务后，执行状态会显示在这里。</p><Button onClick={onNewTask}>新建任务</Button></div>}
      </section>
    </div>
  </main>
}
