import { ArrowRight, CalendarDays, Check, CheckCircle2, Circle, CircleDot, ListChecks, Pause, Target, Users } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { RuntimeLogo } from './RuntimeLogo'
import { GoalProgress } from './GoalProgress'
import { getTaskStatus } from '@/lib/domain'
import { getGoalProgress, isAcceptedTaskDone, isBusinessTask } from '@/lib/goal-progress'
import { taskStatusLabels } from '@/lib/workspace'
import { getCurrentLanguage, translate, useI18n } from '@/i18n'
import type { GoalStatus } from '@/lib/goal-types'
import type { AppState, RunStatus, Task } from '@/lib/types'
import './dashboard.css'

const openGoalStatuses = new Set<GoalStatus>(['clarifying', 'active', 'paused', 'maintenance'])
const goalStatusLabel = (status: GoalStatus) => ({
  clarifying: translate('待澄清', 'Needs clarification'), active: translate('进行中', 'In progress'),
  paused: translate('已暂停', 'Paused'), achieved: translate('已完成', 'Achieved'),
  maintenance: translate('持续维护', 'Maintaining'), ended: translate('已结束', 'Ended'),
})[status]
const taskStatusLabel = (status: keyof typeof taskStatusLabels) => ({
  todo: translate('待开始', 'To do'), in_progress: translate('进行中', 'In progress'),
  blocked: translate('受阻', 'Blocked'), review: translate('待验收', 'In review'),
  done: translate('已完成', 'Done'), cancelled: translate('已取消', 'Cancelled'),
})[status]

function latestTaskTime(task: Task) {
  const times = [task.createdAt, ...task.messages.map(message => message.createdAt), ...task.runs.map(run => run.createdAt),
    ...task.events.map(event => event.timestamp), ...(task.results ?? []).flatMap(result => [result.createdAt, result.reviewedAt ?? ''])]
    .map(value => Date.parse(value) || 0)
  return Math.max(...times)
}

function completionTime(task: Task) {
  if (!isAcceptedTaskDone(task)) return 0
  const result = task.results!.at(-1)!
  return Date.parse(result.reviewedAt ?? result.createdAt) || 0
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

function relativeTime(timestamp: number, now: Date) {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000))
  if (seconds < 60) return translate('刚刚', 'Just now')
  if (seconds < 3600) return `${Math.floor(seconds / 60)} ${translate('分钟前', 'min ago')}`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${translate('小时前', 'hr ago')}`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} ${translate('天前', 'days ago')}`
  return new Intl.DateTimeFormat(getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit' }).format(timestamp)
}

function runState(task: Task): { status: RunStatus | 'idle'; label: string } {
  const execution = getTaskStatus(task)
  if (execution === 'running') return { status: 'running', label: translate('运行中', 'Running') }
  if (execution === 'failed') return { status: 'failed', label: translate('失败', 'Failed') }
  const business = task.businessStatus ?? 'todo'
  if (isAcceptedTaskDone(task)) return { status: 'completed', label: translate('已完成', 'Done') }
  if (business === 'done') return { status: 'idle', label: translate('待验收', 'In review') }
  if (business === 'blocked') return { status: 'interrupted', label: translate('已阻塞', 'Blocked') }
  return { status: 'idle', label: taskStatusLabel(business) }
}

function GoalStateIcon({ status }: { status: GoalStatus }) {
  if (status === 'paused') return <Pause size={13} />
  if (status === 'maintenance') return <CheckCircle2 size={13} />
  return <CircleDot size={13} />
}

export function DashboardPage({ state, onGoal, onTask, onGoals, onTasks, onNewTask, now = new Date() }: {
  state: AppState; onGoal: (id: string) => void; onTask: (id: string) => void; onGoals: () => void; onTasks: () => void; onNewTask: () => void; now?: Date
}) {
  const { t, language } = useI18n()
  const tasks = state.tasks.filter(isBusinessTask)
  const openGoals = state.goals.filter(goal => openGoalStatuses.has(goal.status))
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const achievedGoals = state.goals.filter(goal => goal.status === 'achieved')
  const measurableOpenGoals = openGoals.map(goal => getGoalProgress(goal, tasks).criteria).filter(progress => progress.percentage !== null)
  const averageProgress = measurableOpenGoals.length
    ? Math.round(measurableOpenGoals.reduce((sum, progress) => sum + (progress.percentage ?? 0), 0) / measurableOpenGoals.length) : null
  const goalCompletion = state.goals.length ? Math.round(achievedGoals.length / state.goals.length * 100) : null
  const weeklyTasks = tasks.filter(task => task.businessStatus !== 'cancelled' && latestTaskTime(task) >= startOfWeek(now))
  const weeklyDone = weeklyTasks.filter(isAcceptedTaskDone)
  const weeklyProgress = weeklyTasks.length ? Math.round(weeklyDone.length / weeklyTasks.length * 100) : null
  const doneToday = weeklyDone.filter(task => completionTime(task) >= startOfDay(now)).length
  const notStarted = weeklyTasks.filter(task => (task.businessStatus ?? 'todo') === 'todo').length
  const recentTasks = [...tasks].sort((left, right) => latestTaskTime(right) - latestTaskTime(left)).slice(0, 6)

  return <main className="workspace-page dashboard-page">
    <header className="workspace-page-heading dashboard-heading">
      <div><span className="eyebrow">{t('工作空间概览', 'Workspace overview')}</span><h1>Dashboard</h1><p>{t('聚合目标推进、任务交付和最近的 Agent 执行。', 'Track goal progress, task delivery, and recent Agent runs.')}</p></div>
      <time dateTime={now.toISOString()}>{new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'short' }).format(now)}</time>
    </header>
    <div className="dashboard-scroll">
      <section className="dashboard-metrics" aria-label={t('工作空间统计', 'Workspace metrics')}>
        <article className="dashboard-metric metric-active">
          <div className="dashboard-metric-label"><Target size={15} /><span>{t('进行中的目标', 'Active goals')}</span></div>
          <strong>{openGoals.length}</strong>
          {averageProgress !== null ? <Progress value={averageProgress} aria-label={`${t('进行中目标标准平均验收率', 'Average active goal criteria verification')} ${averageProgress}%`} /> : <span className="dashboard-muted" aria-label={t('目标验收进度未定义', 'Goal verification progress is undefined')}>—</span>}
          <p>{averageProgress !== null ? `${t('标准平均验收率', 'Average criteria verification')} ${averageProgress}% · ${measurableOpenGoals.length} ${t('个目标已有完成标准', 'goals have completion criteria')}` : t('等待定义目标完成标准', 'Define goal completion criteria to measure verification')}</p>
        </article>
        <article className="dashboard-metric metric-complete">
          <div className="dashboard-metric-label"><CheckCircle2 size={15} /><span>{t('已完成的目标', 'Achieved goals')}</span><Badge variant="outline">{goalCompletion === null ? '—' : `${goalCompletion}%`}</Badge></div>
          <strong>{achievedGoals.length}<small>/ {state.goals.length} {t('总目标', 'total goals')}</small></strong>
          {goalCompletion !== null ? <Progress value={goalCompletion} aria-label={`${t('目标完成率', 'Goal completion rate')} ${goalCompletion}%`} /> : <span className="dashboard-muted">—</span>}
          <p>{state.goals.length ? `${t('完成率', 'Completion rate')} ${goalCompletion}% · ${state.goals.length - achievedGoals.length} ${t('个目标仍在生命周期中', 'goals are still active')}` : t('创建目标后，这里会展示整体完成率', 'Create a goal to see the overall completion rate')}</p>
        </article>
        <article className="dashboard-metric metric-week">
          <div className="dashboard-metric-label"><ListChecks size={15} /><span>{t('本周任务完成', 'Tasks completed this week')}</span><CalendarDays size={14} /></div>
          <strong>{weeklyDone.length}<small>/ {weeklyTasks.length}</small></strong>
          {weeklyProgress !== null ? <Progress value={weeklyProgress} aria-label={`${t('本周任务完成率', 'Weekly task completion rate')} ${weeklyProgress}%`} /> : <span className="dashboard-muted">—</span>}
          <p>{weeklyTasks.length ? `${weeklyProgress}% ${t('完成', 'done')} · ${t('今日完成', 'Done today')} ${doneToday} · ${t('未开始', 'Not started')} ${notStarted}` : t('本周还没有真实任务活动', 'No task activity this week')}</p>
        </article>
      </section>

      <section className="dashboard-section" aria-labelledby="active-goals-heading">
        <div className="dashboard-section-heading"><h2 id="active-goals-heading"><CircleDot size={16} />{t('活跃目标', 'Active goals')}</h2><Button variant="ghost" size="sm" onClick={onGoals}>{t('查看全部', 'View all')} <ArrowRight size={13} /></Button></div>
        {openGoals.length ? <div className="dashboard-goal-grid">{openGoals.slice(0, 4).map(goal => {
          const progress = getGoalProgress(goal, tasks)
          const linked = progress.tasks.items.map(item => item.task)
          const nextTask = [...linked].sort((left, right) => {
            const leftRunning = getTaskStatus(left) === 'running' ? 1 : 0
            const rightRunning = getTaskStatus(right) === 'running' ? 1 : 0
            return rightRunning - leftRunning || latestTaskTime(right) - latestTaskTime(left)
          })[0]
          return <article className={`dashboard-goal-card goal-${goal.status}`} key={goal.id}>
            <div className="dashboard-goal-title"><h3 title={goal.title}>{goal.title}</h3><strong aria-label={`${goal.title}：${t('目标标准验收率', 'Goal criteria verification')} ${progress.criteria.percentage === null ? '—' : `${progress.criteria.percentage}%`}`} title={t('目标标准验收率', 'Goal criteria verification')}>{progress.criteria.percentage === null ? '—' : `${progress.criteria.percentage}%`}</strong></div>
            <div className="dashboard-goal-meta"><span><GoalStateIcon status={goal.status} />{goalStatusLabel(goal.status)}</span><i aria-hidden="true" />{t('最后更新', 'Updated')}: {relativeTime(Date.parse(goal.updatedAt) || 0, now)}</div>
            <GoalProgress goal={goal} tasks={tasks} onTasks={onTasks} onCriterion={() => onGoal(goal.id)} />
            <div className="dashboard-goal-actions"><Button variant="outline" onClick={() => onGoal(goal.id)}>{t('查看详情', 'View details')}</Button><Button onClick={() => nextTask ? onTask(nextTask.id) : onGoal(goal.id)}>{nextTask ? t('继续执行', 'Continue') : t('完善目标', 'Refine goal')}<ArrowRight size={13} /></Button></div>
          </article>
        })}</div> : <div className="dashboard-empty"><Target size={24} /><h3>{t('还没有活跃目标', 'No active goals yet')}</h3><p>{t('先定义预期结果和成功条件，再把任务关联到目标。', 'Define the outcome and success criteria, then link tasks to the goal.')}</p><Button onClick={onGoals}>{t('创建目标', 'Create goal')}</Button></div>}
      </section>

      <section className="dashboard-section dashboard-recent" aria-labelledby="recent-tasks-heading">
        <div className="dashboard-section-heading"><h2 id="recent-tasks-heading"><ListChecks size={16} />{t('最近执行的任务', 'Recently run tasks')}</h2><Button variant="ghost" size="sm" onClick={onTasks}>{t('查看全部', 'View all')} <ArrowRight size={13} /></Button></div>
        {recentTasks.length ? <div className="dashboard-table"><Table>
          <TableHeader><TableRow><TableHead>{t('任务名', 'Task')}</TableHead><TableHead>{t('所属目标', 'Goal')}</TableHead><TableHead>{t('执行者', 'Executor')}</TableHead><TableHead>{t('状态', 'Status')}</TableHead><TableHead className="dashboard-time-column">{t('最后活动', 'Last activity')}</TableHead></TableRow></TableHeader>
          <TableBody>{recentTasks.map(task => {
            const latestRun = task.runs.at(-1)
            const members = latestRun?.members ?? []
            const runtime = members[0]?.runtime ?? state.settings.runtimes.find(item => item.id === task.members[0]?.runtimeId)
            const status = runState(task)
            const goal = state.goals.find(item => item.id === task.goalId)
            return <TableRow key={task.id}>
              <TableCell><Button variant="link" className="dashboard-task-link" onClick={() => onTask(task.id)}>{task.title}</Button></TableCell>
              <TableCell>{goal ? <Button variant="link" className="dashboard-goal-link" onClick={() => onGoal(goal.id)}>{goal.title}</Button> : <span className="dashboard-muted">{t('独立任务', 'Independent task')}</span>}</TableCell>
              <TableCell><span className="dashboard-runtime">{task.executor === 'human' ? <><Users size={14} />{t('人工', 'Human')}</> : <><RuntimeLogo runtime={runtime} runtimeId={task.members[0]?.runtimeId} size={15} />{runtime?.name ?? task.members[0]?.name ?? t('未配置', 'Not configured')}{members.length > 1 && <small>+{members.length - 1}</small>}</>}</span></TableCell>
              <TableCell><span className={`dashboard-task-status status-${status.status}`}>{status.status === 'completed' ? <Check size={13} /> : status.status === 'running' ? <CircleDot size={13} /> : <Circle size={13} />}{status.label}</span></TableCell>
              <TableCell className="dashboard-time-column"><time dateTime={new Date(latestTaskTime(task)).toISOString()}>{relativeTime(latestTaskTime(task), now)}</time></TableCell>
            </TableRow>
          })}</TableBody>
        </Table></div> : <div className="dashboard-empty dashboard-empty-compact"><ListChecks size={24} /><h3>{t('还没有真实任务', 'No tasks yet')}</h3><p>{t('示例任务不会计入 Dashboard。创建任务后，执行状态会显示在这里。', 'Demo tasks are excluded. Create a task to see its run status here.')}</p><Button onClick={onNewTask}>{t('新建任务', 'New task')}</Button></div>}
      </section>
    </div>
  </main>
}
