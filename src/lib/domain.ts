import type { AppState, Member, Message, RunStatus, RuntimeEvent, Settings, Task } from './types'
import { reconcileSteps } from './workspace'
import { traexDescription } from './traex-runtime'
import { advanceRuntimeOutput, getRuntimeOutput, getRuntimeSessionId } from './runtime-output'
import { translate } from '@/i18n'
export { getRunActivity } from './runtime-output'
export type { RunActivity } from './runtime-output'

const id = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const terminalStatuses: RunStatus[] = ['completed', 'failed', 'stopped', 'interrupted']

/** Summarize the latest execution without equating cancellation with success. */
export function getTaskStatus(task: Task): RunStatus | 'idle' {
  const members = task.runs.at(-1)?.members
  if (!members?.length) return 'idle'
  const priority: RunStatus[] = ['running', 'failed', 'interrupted', 'stopped', 'completed']
  return priority.find(status => members.some(member => member.status === status)) ?? 'idle'
}

export function createInitialState(): AppState {
  const settings: Settings = {
    runtimes: [
      { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: translate('使用本机 Codex CLI 的登录与配置；安装状态需检测。', 'Uses local Codex CLI login and configuration; installation must be checked.') },
      { id: 'claude', name: 'Claude Code', executable: 'claude', adapter: 'claude', enabled: true, args: [], defaultModel: '', description: translate('使用本机 Claude Code CLI 的登录与配置；安装状态需检测。', 'Uses local Claude Code CLI login and configuration; installation must be checked.') },
      { id: 'traex', name: 'TraeX', executable: 'traex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: translate(traexDescription, 'Uses local TraeX CLI login and configuration; shares execution and session protocols with Codex.') },
      { id: 'kimi', name: 'Kimi CLI', executable: 'kimi', adapter: 'kimi', enabled: false, args: [], defaultModel: '', description: translate('通过 ACP 执行，默认自动批准工具请求；模型与思考设置继承 Runtime。', 'Runs through ACP and approves tool requests by default; model and reasoning settings come from the runtime.') },
      { id: 'pi', name: 'Pi', executable: 'pi', adapter: 'pi', enabled: false, args: [], defaultModel: '', description: translate('通过 JSON 事件流执行并续接任务会话；登录、工具权限与思考设置继承 Pi。', 'Runs through JSON events and resumes task sessions; login, tool permissions, and reasoning settings come from Pi.') },
      { id: 'deepseek-harness', name: 'DeepSeek Harness', executable: 'dsh', adapter: 'generic', enabled: false, args: [], defaultModel: '', description: translate('启用前确认本机 Harness 的可执行路径、参数和输入方式。', 'Confirm the local Harness executable, arguments, and input method before enabling.') },
    ],
    models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo',
    maxParallel: 3, defaultDirectory: '', theme: 'system',
  }
  const demo = createTask(settings, translate('为工作台增加全局命令面板', 'Add a global command palette to the workbench'), '', 'team')
  demo.demo = true
  const pi = settings.runtimes.find(runtime => runtime.id === 'pi')!
  demo.members[2] = { ...demo.members[2], runtimeId: pi.id, name: 'Pi' }
  const runId = id()
  const createdAt = demo.createdAt
  demo.runs = [{
    id: runId, createdAt, directory: '', prompt: translate('设计一个可通过 ⌘K 打开的全局命令面板，支持搜索任务与运行时。', 'Design a global command palette opened with Command+K to search tasks and runtimes.'),
    members: demo.members.map(member => ({
      ...member,
      runtime: { ...settings.runtimes.find(runtime => runtime.id === member.runtimeId)!, args: [] },
      model: '', status: 'completed',
    })),
  }]
  demo.messages = [
    { id: id(), role: 'system', text: translate('这是设计演示，以下对话和执行记录均为示例，未启动任何 Runtime。创建真实任务后才能执行。', 'This is a design demo. The conversation and run history below are examples; no runtime was started. Create a real task to run an agent.'), createdAt },
    { id: id(), role: 'user', text: translate('为工作台增加一个全局命令面板，支持搜索任务、切换运行时，并支持键盘操作。', 'Add a global command palette to the workbench for searching tasks, switching runtimes, and using the keyboard.'), createdAt },
    { id: id(), role: 'assistant', memberId: demo.members[0].id, runId, text: translate('示例分工：\n1. 协调 / 实现：梳理命令与搜索入口。\n2. 测试：检查键盘导航、焦点恢复和空结果。\n3. 审查：检查交互一致性与可访问性。\n\n本任务用于展示工作台结构；没有实际生成文件或运行测试。', 'Example assignments:\n1. Coordination / Implementation: define command and search entry points.\n2. Testing: check keyboard navigation, focus restoration, and empty results.\n3. Review: check interaction consistency and accessibility.\n\nThis task demonstrates the workbench layout; no files or tests were actually run.'), createdAt },
  ]
  demo.events = demo.members.map(member => ({
    id: id(), taskId: demo.id, runId, memberId: member.id, timestamp: createdAt,
    kind: 'completed', text: translate(`示例记录 · ${member.role} · 未执行真实命令`, `Demo record · ${member.role} · No real command executed`), exitCode: null,
  }))
  return { version: 2, goals: [], agents: [], settings, tasks: [demo], activeTaskId: demo.id }
}

export function createTask(settings: Settings, title: string, directory: string, mode: 'solo' | 'team'): Task {
  const enabled = settings.runtimes.filter(runtime => runtime.enabled && runtime.executable.trim()
    && (runtime.adapter !== 'generic' || runtime.args.some(arg => arg.includes('{prompt}'))))
  if (enabled.length === 0) throw new Error(translate('请先在设置中启用至少一个 Runtime。', 'Enable at least one runtime in Settings first.'))
  const preferred = enabled.find(runtime => runtime.id === settings.defaultRuntime) ?? enabled[0]
  const runtimes = [preferred, ...enabled.filter(runtime => runtime.id !== preferred.id)]
  const parallel = Number.isFinite(settings.maxParallel) ? Math.max(1, Math.min(3, Math.floor(settings.maxParallel))) : 1
  const roles = mode === 'solo' ? [translate('执行', 'Execution')] : [translate('协调 / 实现', 'Coordination / Implementation'), translate('测试', 'Testing'), translate('审查', 'Review')].slice(0, parallel)
  return {
    id: id(), title: title.trim() || translate('新任务', 'New task'), directory: directory.trim(), mode,
    members: roles.map((role, index) => {
      const runtime = runtimes[index % runtimes.length]
      return { id: id(), name: runtime.name, role, runtimeId: runtime.id, modelId: runtime.defaultModel }
    }),
    messages: [], runs: [], events: [], createdAt: now(),
  }
}

export function applyRuntimeEvent(state: AppState, event: RuntimeEvent): AppState {
  if (!['started', 'stdout', 'stderr', 'completed', 'failed', 'stopped'].includes(event.kind)) return state
  const taskIndex = state.tasks.findIndex(task => task.id === event.taskId && !task.demo)
  if (taskIndex < 0) return state
  const task = state.tasks[taskIndex]
  const runIndex = task.runs.findIndex(run => run.id === event.runId)
  if (runIndex < 0) return state
  const run = task.runs[runIndex]
  const memberIndex = run.members.findIndex(member => member.id === event.memberId)
  if (memberIndex < 0 || task.events.some(existing => existing.id === event.id)) return state

  let status = run.members[memberIndex].status
  if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'stopped') {
    // The first actual terminal signal wins; late stdout/started cannot resurrect it.
    if (status === 'running' || status === 'interrupted') status = event.kind
  } else if (event.kind === 'started' && !terminalStatuses.includes(status)) status = 'running'
  const nextRun = { ...run, members: run.members.map((member, index) => index === memberIndex ? { ...member, status } : member) }
  const nextTask: Task = { ...task, runs: task.runs.map((entry, index) => index === runIndex ? nextRun : entry), events: [...task.events, { ...event }] }

  const outputs = advanceRuntimeOutput(task, nextTask, event)
  const sessionId = getRuntimeSessionId(nextTask, nextRun, nextRun.members[memberIndex])
  if (sessionId) nextRun.members[memberIndex] = { ...nextRun.members[memberIndex], sessionId }
  if (event.kind === 'stdout' || ['completed', 'failed', 'stopped'].includes(event.kind)) {
    const prefix = `runtime:${run.id}:${event.memberId}:`
    const derived: Message[] = outputs.map(output => ({
      id: `${prefix}${output.key}`, role: 'assistant', memberId: event.memberId, runId: run.id,
      text: output.text, createdAt: output.createdAt, streaming: output.streaming, kind: output.kind,
    }))
    const previous = new Map(derived.map(message => [message.id, message]))
    nextTask.messages = task.messages.flatMap(message => {
      if (!message.id.startsWith(prefix)) return [message]
      const updated = previous.get(message.id)
      previous.delete(message.id)
      return updated ? [updated] : []
    })
    nextTask.messages.push(...previous.values())
    nextTask.messages.sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0))
  }
  return { ...state, tasks: state.tasks.map((entry, index) => index === taskIndex ? reconcileSteps(nextTask) : entry) }
}

/** Merge the recovery journal once; derive public messages once afterwards.
 * Replaying the live reducer for every record scans/copies an ever-growing trace.
 */
export function mergeRecoveredEvents(state: AppState, events: RuntimeEvent[]): AppState {
  if (!events.length) return state
  const byTask = new Map<string, RuntimeEvent[]>()
  for (const event of events) {
    const group = byTask.get(event.taskId)
    if (group) group.push(event)
    else byTask.set(event.taskId, [event])
  }
  const tasks = state.tasks.map(task => {
    const candidates = byTask.get(task.id)
    if (task.demo || !candidates) return task
    const seen = new Set(task.events.map(event => event.id))
    const routes = new Map(task.runs.map(run => [run.id, new Map(run.members.map(member => [member.id, member.status]))]))
    const missing: RuntimeEvent[] = []
    for (const event of candidates) {
      if (!['started', 'stdout', 'stderr', 'completed', 'failed', 'stopped'].includes(event.kind)) continue
      const members = routes.get(event.runId)
      const status = members?.get(event.memberId)
      if (!members || !status || seen.has(event.id)) continue
      seen.add(event.id)
      missing.push(event)
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'stopped') {
        if (status === 'running' || status === 'interrupted') members.set(event.memberId, event.kind)
      } else if (event.kind === 'started' && !terminalStatuses.includes(status)) members.set(event.memberId, 'running')
    }
    if (!missing.length) return task
    return { ...task, events: [...task.events, ...missing], runs: task.runs.map(run => ({
      ...run, members: run.members.map(member => ({ ...member, status: routes.get(run.id)!.get(member.id)! })),
    })) }
  })
  return tasks.every((task, index) => task === state.tasks[index]) ? state : { ...state, tasks }
}

export function recoverInterruptedState(state: AppState): AppState {
  const tasks = state.tasks.map(task => {
    // Old application versions persisted raw delta events without deriving
    // public messages. Rebuild from the trace even when delivery IDs are
    // already present, while retaining saved chat when a trace is unavailable.
    const messages = new Map(task.messages.map(message => [message.id, message.streaming ? { ...message, streaming: false } : message]))
    if (!task.demo) for (const run of task.runs) for (const member of run.members) {
      const outputs = getRuntimeOutput(task, run, member)
      const prefix = `runtime:${run.id}:${member.id}:`
      if (member.runtime.adapter === 'claude' && outputs.length) {
        // Older versions ignored deltas and saved only the final result. The
        // same answer now uses its streamed message ID. Remove only this
        // proven duplicate; unavailable or incomplete traces must not erase chat.
        const comparable = (text: string) => text.trim().replace(/\r\n/g, '\n')
        const derivedIds = new Set(outputs.map(output => `${prefix}${output.key}`))
        const publicOutputs = outputs.filter(output => output.kind === 'message')
        const texts = new Set(publicOutputs.map(output => comparable(output.text)))
        texts.add(comparable(publicOutputs.map(output => output.text).join('\n\n')))
        for (const [id, message] of messages) {
          if (id.startsWith(`${prefix}result:`) && !derivedIds.has(id) && texts.has(comparable(message.text))) messages.delete(id)
        }
      }
      for (const output of outputs) {
        const id = `${prefix}${output.key}`
        const previous = messages.get(id)
        if (!previous || previous.role !== 'assistant' || previous.memberId !== member.id || previous.runId !== run.id || previous.text !== output.text || previous.createdAt !== output.createdAt || previous.streaming || previous.kind !== output.kind) {
          messages.set(id, { id, role: 'assistant', memberId: member.id, runId: run.id, text: output.text, createdAt: output.createdAt, streaming: false, kind: output.kind })
        }
      }
    }
    const recoveredMessages = [...messages.values()].sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0))
    const runs = task.runs.map(run => {
      const members = run.members.map(member => {
        const sessionId = getRuntimeSessionId(task, run, member)
        const status = member.status === 'running' ? 'interrupted' as const : member.status
        return sessionId !== member.sessionId || status !== member.status ? { ...member, sessionId, status } : member
      })
      return members.every((member, index) => member === run.members[index]) ? run : { ...run, members }
    })
    if (recoveredMessages.length === task.messages.length && recoveredMessages.every((message, index) => message === task.messages[index]) && runs.every((run, index) => run === task.runs[index])) return task
    return {
      ...task,
      messages: recoveredMessages,
      runs,
    }
  })
  return tasks.every((task, index) => task === state.tasks[index]) ? state : { ...state, tasks }
}

export function buildPrompt(task: Task, prompt: string, member: Member, resumed = false): string {
  const limit = (value: string, length: number) => value.length <= length ? value : `${value.slice(0, length)}\n[内容过长，已截断]`
  const history = resumed ? '' : task.messages.filter(message => message.kind !== 'reasoning').map(message => {
    const author = message.memberId ? task.members.find(candidate => candidate.id === message.memberId)?.role ?? message.memberId : message.role
    return `[${message.role} · ${author}]\n${message.text}`
  }).join('\n\n')
  return [
    `任务：${limit(task.title, 300)}`,
    `你的成员名称：${limit(member.name, 100)}；职责：${limit(member.role, 300)}`,
    `职责指令：${limit(member.instructions || member.role, 6000)}`,
    ...(task.delivery ? [`预期产物：${limit(task.delivery, 2000)}`] : []),
    ...(task.deadline ? [`任务截止日期：${task.deadline}`] : []),
    `验收要求：${limit(task.acceptance || '尚未约定；请在结果中列出验证与限制。', 2000)}`,
    `执行方式：${task.mode === 'team' ? '多成员协作；只负责你的职责范围，不假定其他成员已完成工作。' : '单 Agent 执行。'}`,
    resumed ? '继续当前 Runtime 原生会话，保留已有上下文。以下为当前任务配置和新的用户指令。' : '这是一次新的 Runtime 会话。下面是管理器保存的完整公开对话；这不代表恢复了旧会话内部状态。',
    `工作目录：${limit(task.directory || '由本次执行配置确定', 500)}`,
    ...(!resumed ? [`已有公开对话（完整保留）：\n${history || '无历史对话。'}`] : []),
    `本次用户指令：\n${prompt.trim()}`,
  ].join('\n\n')
}
