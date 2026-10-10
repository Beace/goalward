import { describe, expect, it } from 'vitest'
import { applyRuntimeEvent, buildPrompt, createInitialState, createTask, getTaskStatus, mergeRecoveredEvents, recoverInterruptedState } from './domain'
import type { AppState, RunStatus, RuntimeEvent } from './types'

function liveState(adapter: 'codex' | 'claude' | 'generic' | 'kimi' = 'codex') {
  const initial = createInitialState()
  const task = createTask(initial.settings, '真实任务', '/tmp/project', 'solo')
  const member = task.members[0]
  const runtime = { ...initial.settings.runtimes[0], args: ['--configured'], adapter }
  task.runs = [{ id: 'run-1', createdAt: '2026-09-15T01:00:00Z', prompt: '执行', directory: task.directory, members: [{ ...member, runtime, model: '', status: 'running' }] }]
  const state: AppState = { ...initial, tasks: [task], activeTaskId: task.id }
  let sequence = 0
  const event = (kind: RuntimeEvent['kind'], text = '', overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
    id: `event-${++sequence}`, taskId: task.id, runId: 'run-1', memberId: member.id,
    timestamp: '2026-09-15T01:00:01Z', kind, text, ...overrides,
  })
  return { state, task, member, event }
}

describe('task and settings defaults', () => {
  it('creates an explicitly non-running demo with no fabricated models or connections', () => {
    const state = createInitialState()
    expect(state.settings.runtimes).toHaveLength(6)
    expect(state.settings.models).toEqual([])
    expect(state.settings.providers).toEqual([])
    expect(state.settings).toMatchObject({ defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '' })
    expect(state.settings.runtimes.every(runtime => runtime.defaultModel === '')).toBe(true)
    expect(state.tasks[0].demo).toBe(true)
    expect(state.tasks[0].members).toHaveLength(3)
    expect(state.tasks[0].runs.flatMap(run => run.members).every(member => member.status !== 'running')).toBe(true)
    expect(state.tasks[0].messages.some(message => message.text.includes('未启动任何 Runtime'))).toBe(true)
  })

  it('uses enabled defaults and independent members, retaining task configuration after settings change', () => {
    const settings = createInitialState().settings
    settings.runtimes[0].defaultModel = 'configured-model-id'
    settings.runtimes.slice(1).forEach(runtime => { runtime.enabled = false })
    const task = createTask(settings, '  搜索  ', ' /tmp/project ', 'team')
    expect(task.title).toBe('搜索')
    expect(task.directory).toBe('/tmp/project')
    expect(task.members).toHaveLength(3)
    expect(new Set(task.members.map(member => member.id)).size).toBe(3)
    expect(task.members.every(member => member.runtimeId === 'codex' && member.modelId === 'configured-model-id')).toBe(true)
    settings.runtimes[0].defaultModel = 'changed'
    expect(task.members[0].modelId).toBe('configured-model-id')
    settings.runtimes[0].enabled = false
    expect(() => createTask(settings, '', '', 'solo')).toThrow('启用至少一个 Runtime')
  })

  it('respects a lower configured parallel limit for new collaboration members', () => {
    const settings = createInitialState().settings
    settings.maxParallel = 2
    expect(createTask(settings, 'pair', '', 'team').members).toHaveLength(2)
    settings.maxParallel = 1
    expect(createTask(settings, 'one', '', 'team').members).toHaveLength(1)
  })
})

describe('runtime events', () => {
  it.each(['codex', 'claude', 'generic', 'kimi'] as const)('batch recovery preserves live replay output and first terminal status for %s', adapter => {
    const { state, event } = liveState(adapter)
    const text = adapter === 'codex'
      ? JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Recovered answer' } })
      : adapter === 'claude' ? JSON.stringify({ type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'Recovered answer' }] } })
      : adapter === 'kimi' ? JSON.stringify({ type: 'kimi.acp.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer' } } }) : 'Recovered answer'
    const first = event('stdout', text.slice(0, 20))
    const initial = applyRuntimeEvent(state, first)
    const events = [first, event('stdout', text.slice(20)), event('completed'), event('failed'), event('started'), event('stdout', 'ignored', { memberId: 'missing' }), event('stdout', 'ignored', { taskId: 'missing' }), event('stdout', 'ignored', { runId: 'missing' })]
    events.push(events[1])
    const expected = recoverInterruptedState(events.reduce(applyRuntimeEvent, initial))
    const merged = recoverInterruptedState(mergeRecoveredEvents(initial, events))
    expect(merged).toEqual(expected)
    expect(merged.tasks[0].runs[0].members[0].status).toBe('completed')
    expect(merged.tasks[0].messages.map(message => message.text)).toContain('Recovered answer')
    expect(initial.tasks[0].events).toEqual([first])
    expect(mergeRecoveredEvents(merged, events)).toBe(merged)
    expect(recoverInterruptedState(merged)).toBe(merged)
  })

  it('deduplicates recovery IDs within each task and leaves demo history alone', () => {
    const a = liveState('generic'), b = liveState('generic')
    const demo = createInitialState().tasks[0]
    const source = { ...a.state, tasks: [a.task, b.task, demo] }
    const events = [a.event('stdout', 'a'), b.event('stdout', 'b'), a.event('stdout', 'ignored', { taskId: demo.id })]
    const merged = recoverInterruptedState(mergeRecoveredEvents(source, events))
    expect(merged.tasks.slice(0, 2).map(task => task.messages[0].text)).toEqual(['a', 'b'])
    expect(merged.tasks[2]).toBe(demo)
  })

  it('ignores events without an exact task/run/member route and never mutates demo records', () => {
    const { state, event } = liveState()
    for (const override of [{ taskId: 'missing' }, { runId: 'missing' }, { memberId: 'missing' }]) {
      expect(applyRuntimeEvent(state, event('completed', '', override))).toBe(state)
    }
    const demo = createInitialState()
    const task = demo.tasks[0]
    expect(applyRuntimeEvent(demo, event('started', '', { taskId: task.id, runId: task.runs[0].id, memberId: task.members[0].id }))).toBe(demo)
  })

  it('deduplicates delivery and Codex items, handles split JSONL, and keeps reasoning out of chat', () => {
    const { state, event } = liveState()
    const raw = JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: '已完成公开结果。' } })
    let next = applyRuntimeEvent(state, event('stdout', raw.slice(0, 35)))
    expect(next.tasks[0].messages).toHaveLength(0)
    const second = event('stdout', raw.slice(35))
    next = applyRuntimeEvent(next, second)
    expect(applyRuntimeEvent(next, second)).toBe(next)
    next = applyRuntimeEvent(next, event('stdout', `${raw}\n${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'do not extract' } })}\n`))
    expect(next.tasks[0].messages.map(message => message.text)).toEqual(['已完成公开结果。'])
    expect(next.tasks[0].events).toHaveLength(3)
    expect(next.tasks[0].events[0].text).toBe(raw.slice(0, 35))
    expect(state.tasks[0].events).toEqual([])
  })

  it('extracts Claude thinking and text blocks without duplicating the result summary', () => {
    const { state, event } = liveState('claude')
    const assistant = { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '公开答复' }, { type: 'tool_use', input: { text: 'not a message' } }] } }
    let next = applyRuntimeEvent(state, event('stdout', JSON.stringify(assistant)))
    next = applyRuntimeEvent(next, event('stdout', JSON.stringify({ type: 'result', result: '公开答复' })))
    expect(next.tasks[0].messages.map(message => [message.kind, message.text])).toEqual([['reasoning', 'private'], ['message', '公开答复']])
    next = applyRuntimeEvent(next, event('stdout', JSON.stringify({ type: 'result', result: '另一段完整总结' })))
    expect(next.tasks[0].messages.map(message => [message.kind, message.text])).toEqual([['reasoning', 'private'], ['message', '公开答复'], ['message', '另一段完整总结']])
  })

  it('keeps terminal status when stdout or started arrives late and uses the historical runtime snapshot', () => {
    const { state, event } = liveState('generic')
    state.settings.runtimes[0].adapter = 'claude'
    state.tasks[0].members[0].runtimeId = 'claude'
    let next = applyRuntimeEvent(state, event('completed', '', { exitCode: 0 }))
    next = applyRuntimeEvent(next, event('stdout', 'first '))
    next = applyRuntimeEvent(next, event('stdout', 'second'))
    next = applyRuntimeEvent(next, event('started'))
    expect(next.tasks[0].runs[0].members[0].status).toBe('completed')
    expect(next.tasks[0].messages.map(message => message.text)).toEqual(['first second'])
    expect(next.tasks[0].runs[0].members[0].runtime.adapter).toBe('generic')
    expect(next.tasks[0].runs[0].members[0].runtime.args).toEqual(['--configured'])
  })

  it('does not mix members or later runs into an older run output', () => {
    const { state, event, member } = liveState('generic')
    const other = { ...state.tasks[0].runs[0].members[0], id: 'other-member' }
    state.tasks[0].runs[0].members.push(other)
    state.tasks[0].runs.push({ ...state.tasks[0].runs[0], id: 'run-2', members: [{ ...state.tasks[0].runs[0].members[0] }] })
    let next = applyRuntimeEvent(state, event('stdout', 'first-run'))
    next = applyRuntimeEvent(next, event('stdout', 'other', { memberId: other.id }))
    next = applyRuntimeEvent(next, event('stdout', 'second-run', { runId: 'run-2' }))
    expect(next.tasks[0].messages.map(message => [message.runId, message.memberId, message.text])).toEqual([
      ['run-1', member.id, 'first-run'], ['run-1', other.id, 'other'], ['run-2', member.id, 'second-run'],
    ])
  })

  it('retains stderr without presenting it as an assistant response and recovers malformed lines', () => {
    const { state, event } = liveState()
    let next = applyRuntimeEvent(state, event('stderr', 'auth failed'))
    next = applyRuntimeEvent(next, event('stdout', '{malformed'))
    next = applyRuntimeEvent(next, event('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '可读取的答复' } })))
    next = applyRuntimeEvent(next, event('failed', 'exit 1', { exitCode: 1 }))
    expect(next.tasks[0].messages.map(message => message.text)).toEqual(['可读取的答复'])
    expect(next.tasks[0].events[0].text).toBe('auth failed')
    expect(next.tasks[0].runs[0].members[0].status).toBe('failed')
  })
})

describe('reload recovery and context handoff', () => {
  it('marks stale running members interrupted without changing completed members or history', () => {
    const { state } = liveState()
    state.tasks[0].runs[0].members.push({ ...state.tasks[0].runs[0].members[0], id: 'finished', status: 'completed' })
    const recovered = recoverInterruptedState(state)
    expect(recovered.tasks[0].runs[0].members.map(member => member.status)).toEqual(['interrupted', 'completed'])
    expect(state.tasks[0].runs[0].members[0].status).toBe('running')
    expect(recovered.tasks[0].runs[0].members[0].runtime).toEqual(state.tasks[0].runs[0].members[0].runtime)
    expect(recoverInterruptedState(recovered)).toEqual(recovered)
  })

  it('preserves all saved public context and the complete instruction for legacy or generic sessions', () => {
    const { task, member } = liveState()
    task.delivery = '导出入口清单'
    task.deadline = '2026-10-16'
    task.messages = Array.from({ length: 12 }, (_, index) => ({ id: String(index), role: 'user', text: `context-${index}:` + 'x'.repeat(2000), createdAt: task.createdAt }))
    const prompt = buildPrompt(task, 'new instruction '.repeat(2000), member)
    expect(prompt).toContain('职责：执行')
    expect(prompt).toContain('预期产物：导出入口清单')
    expect(prompt).toContain('任务截止日期：2026-10-16')
    expect(prompt).toContain('不代表恢复了旧会话内部状态')
    expect(prompt).toContain('context-11:')
    expect(prompt).toContain('context-0:')
    expect(prompt).not.toContain('已截断')
    expect(prompt).toContain('x'.repeat(2000))
    expect(prompt).toContain('new instruction '.repeat(2000).trim())
  })

  it('keeps rendered reasoning out of the next Runtime prompt', () => {
    const { task, member } = liveState()
    task.messages = [
      { id: 'thinking', role: 'assistant', kind: 'reasoning', text: '内部推演不应回传', createdAt: task.createdAt, runId: 'run', memberId: member.id },
      { id: 'answer', role: 'assistant', kind: 'message', text: '公开结论需要保留', createdAt: task.createdAt, runId: 'run', memberId: member.id },
    ]
    const prompt = buildPrompt(task, '继续处理', member)
    expect(prompt).toContain('公开结论需要保留')
    expect(prompt).not.toContain('内部推演不应回传')
  })
})

describe('task status summary', () => {
  it('keeps tasks without an execution or with an empty member list idle', () => {
    const { task } = liveState()
    task.runs = []
    expect(getTaskStatus(task)).toBe('idle')
    task.runs.push({ id: 'empty', createdAt: task.createdAt, directory: '', prompt: '', members: [] })
    expect(getTaskStatus(task)).toBe('idle')
  })

  it.each<{ statuses: RunStatus[]; expected: RunStatus }>([
    { statuses: ['completed', 'completed'], expected: 'completed' },
    { statuses: ['completed', 'stopped'], expected: 'stopped' },
    { statuses: ['stopped', 'interrupted'], expected: 'interrupted' },
    { statuses: ['interrupted', 'failed'], expected: 'failed' },
    { statuses: ['failed', 'running'], expected: 'running' },
    { statuses: ['stopped'], expected: 'stopped' },
    { statuses: ['interrupted'], expected: 'interrupted' },
  ])('summarizes $statuses as $expected', ({ statuses, expected }) => {
    const { task } = liveState()
    const member = task.runs[0].members[0]
    task.runs[0].members = statuses.map((status, index) => ({ ...member, id: `member-${index}`, status }))
    expect(getTaskStatus(task)).toBe(expected)
  })

  it('uses the latest execution rather than carrying old failure into a successful retry', () => {
    const { task } = liveState()
    task.runs[0].members[0].status = 'failed'
    task.runs.push({ ...task.runs[0], id: 'retry', members: [{ ...task.runs[0].members[0], status: 'completed' }] })
    expect(getTaskStatus(task)).toBe('completed')
    task.runs[1].members[0].status = 'stopped'
    expect(getTaskStatus(task)).toBe('stopped')
  })
})
