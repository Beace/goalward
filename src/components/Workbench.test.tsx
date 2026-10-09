// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Workbench } from './Workbench'
import type { Run, Settings, Task } from '@/lib/types'

const runtime = { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex' as const, enabled: true, args: [], defaultModel: 'gpt-6-astra', description: '' }
const member = { id: 'member', name: 'Codex', role: '执行', runtimeId: 'codex', modelId: 'gpt-6-astra' }
function settings(): Settings {
  return {
    runtimes: [runtime],
    models: [{ id: 'model', name: 'Astra', modelId: 'gpt-6-astra', providerId: '', runtimeIds: ['codex'], enabled: true, reasoningEffort: 'high' }],
    providers: [], defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '', outputLimit: 65536,
  }
}
function task(): Task {
  return { id: 'task', title: '测试思考强度', directory: '/tmp/task', mode: 'solo', members: [member], messages: [], events: [], runs: [], createdAt: '2026-09-16T00:00:00Z' }
}
function run(id: string): Run {
  return { id, createdAt: '2026-09-16T00:00:00Z', prompt: 'test', directory: '/tmp/task', members: [{ ...member, runtime, model: 'gpt-6-astra', status: 'completed', effectiveReasoningEffort: 'low' }] }
}
function mount(current = task(), config = settings(), selectedRunId = '', manage = true) {
  const onChange = vi.fn<(task: Task) => void>()
  render(<Workbench task={current} settings={config} selectedRunId={selectedRunId} onChange={onChange} onSelectRun={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
  if (manage) {
    fireEvent.click(screen.getByRole('button', { name: /^消息接收者：/ }))
    fireEvent.click(screen.getByRole('button', { name: '成员与 Runtime' }))
  }
  return onChange
}
async function selectOption(label: string, name: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' })
  const option = await screen.findByRole('option', { name })
  option.focus()
  fireEvent.keyDown(option, { key: 'Enter' })
}
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('composer runtime selection', () => {
  it.each([false, true])('switches only the recipient and resets model/effort while preserving the run and draft (running=%s)', async running => {
    const config = settings()
    config.runtimes.push({ ...runtime, id: 'claude', name: 'Claude Code', adapter: 'claude', defaultModel: 'claude-model' })
    config.runtimes.push({ ...runtime, id: 'disabled', name: 'Disabled Runtime', enabled: false })
    config.models.push({ ...config.models[0], id: 'claude-model', name: 'Claude Model', modelId: 'claude-model', runtimeIds: ['claude'] })
    const initial = task()
    initial.mode = 'team'
    initial.members = [{ ...member, reasoningEffort: 'ultra' }, { ...member, id: 'reviewer', role: '审查' }]
    initial.runs = [run('latest')]
    if (running) initial.runs[0].members[0].status = 'running'
    const onChange = vi.fn()
    function Harness() {
      const [current, setCurrent] = useState(initial)
      return <Workbench task={current} settings={config} selectedRunId="" onChange={next => { onChange(next); setCurrent(next) }} onSelectRun={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />
    }
    render(<Harness />)
    fireEvent.change(screen.getByRole('textbox', { name: '任务指令' }), { target: { value: '保留待发送的指令' } })
    fireEvent.click(screen.getByRole('button', { name: /^消息接收者：/ }))
    fireEvent.keyDown(screen.getByRole('combobox', { name: '执行 Runtime' }), { key: 'Enter' })
    expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Codex', 'Claude Code'])
    const option = screen.getByRole('option', { name: 'Claude Code' })
    option.focus(); fireEvent.keyDown(option, { key: 'Enter' })
    const changed = onChange.mock.calls.at(-1)?.[0] as Task
    expect(changed.members[0]).toMatchObject({ id: member.id, role: member.role, name: 'Claude Code', runtimeId: 'claude', modelId: 'claude-model' })
    expect(changed.members[0].reasoningEffort).toBeUndefined()
    expect(changed.members[1]).toEqual(initial.members[1])
    expect(changed.runs).toEqual(initial.runs)
    expect(screen.getByRole('button', { name: /^消息接收者：/ }).textContent).toContain('执行 · Claude Code')
    expect(screen.getByRole('button', { name: '选择模型 Claude Model' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: '选择模型 Astra' })).toBeNull()
    expect((screen.getByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement).value).toBe('保留待发送的指令')
    if (running) expect(screen.getByText(/配置更改下次执行生效/).textContent).toContain('本次：Codex')
    fireEvent.click(screen.getByRole('button', { name: '所有成员' }))
    expect(screen.queryByRole('combobox', { name: /Runtime$/ })).toBeNull()
  })

  it('displays the original runtime as read-only when viewing a historical run', () => {
    const current = task()
    current.runs = [run('old'), run('latest')]
    const config = settings()
    config.runtimes[0] = { ...runtime, name: 'Renamed current runtime' }
    const onChange = mount(current, config, 'old', false)
    fireEvent.click(screen.getByRole('button', { name: /^消息接收者：/ }))
    const picker = screen.getByRole('combobox', { name: '执行 Runtime' }) as HTMLButtonElement
    expect(picker.disabled).toBe(true)
    expect(picker.textContent).toBe('Codex')
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('member reasoning controls', () => {
  it('lets Kimi members select model-supported effort without changing the active run snapshot', async () => {
    const config = settings()
    const kimi = { ...runtime, id: 'kimi', name: 'Kimi CLI', adapter: 'kimi' as const, executable: 'kimi', defaultModel: 'kimi-code/k3' }
    config.runtimes = [kimi]
    config.models = [{ ...config.models[0], modelId: 'kimi-code/k3', name: 'K3', runtimeIds: ['kimi'], supportedReasoningEfforts: ['low', 'high', 'max'] }]
    const current = task()
    current.members = [{ ...member, runtimeId: 'kimi', modelId: 'kimi-code/k3', reasoningEffort: 'low' }]
    current.runs = [{ ...run('kimi-active'), members: [{ ...current.members[0], runtime: kimi, model: 'kimi-code/k3', status: 'running', effectiveReasoningEffort: 'low' }] }]
    const onChange = mount(current, config)
    fireEvent.keyDown(screen.getByRole('combobox', { name: '执行 思考强度' }), { key: 'Enter' })
    expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['模型默认 · 高 · high', 'Runtime 默认', '低 · low', '高 · high', '最高 · max'])
    const max = screen.getByRole('option', { name: '最高 · max' })
    max.focus(); fireEvent.keyDown(max, { key: 'Enter' })
    const changed = onChange.mock.calls.at(-1)?.[0]
    expect(changed?.members[0].reasoningEffort).toBe('max')
    expect(changed?.runs[0].members[0].effectiveReasoningEffort).toBe('low')
  })
  it('inherits the model default without materializing a member override, then stores explicit selections', async () => {
    const onChange = mount()
    expect(screen.getByRole('combobox', { name: '执行 思考强度' }).textContent).toBe('模型默认')
    expect(screen.getByRole('combobox', { name: '执行 思考强度' }).getAttribute('title')).toBe('执行 思考强度：模型默认 · 高 · high')
    expect(onChange).not.toHaveBeenCalled()
    await selectOption('执行 思考强度', '中 · medium')
    expect(onChange.mock.calls.at(-1)?.[0].members[0].reasoningEffort).toBe('medium')
  })

  it('shows execution snapshots during a run while allowing changes for the next run', async () => {
    const current = task()
    const active = run('active')
    active.members[0].status = 'running'
    current.runs = [active]
    const onChange = mount(current)
    expect(screen.getByText(/本次思考：低 · low/)).toBeTruthy()
    expect(screen.getByText(/新配置下次执行生效/)).toBeTruthy()
    await selectOption('执行 思考强度', '超高 · xhigh')
    const changed = onChange.mock.calls.at(-1)?.[0]
    expect(changed?.members[0].reasoningEffort).toBe('xhigh')
    expect(changed?.runs[0].members[0].effectiveReasoningEffort).toBe('low')
  })

  it('renders a historical snapshot instead of recomputing the current model default', () => {
    const current = task()
    current.runs = [run('old'), run('latest')]
    const onChange = mount(current, settings(), 'old')
    const control = screen.getByRole('combobox', { name: '执行 思考强度' }) as HTMLButtonElement
    expect(control.disabled).toBe(true)
    expect(control.textContent).toBe('low')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uses a short selected value while keeping the full menu label and tooltip', async () => {
    const current = task()
    current.members[0] = { ...member, reasoningEffort: 'xhigh' }
    mount(current)
    const control = screen.getByRole('combobox', { name: '执行 思考强度' })
    expect(control.textContent).toBe('xhigh')
    expect(control.getAttribute('title')).toBe('执行 思考强度：超高 · xhigh')
    fireEvent.keyDown(control, { key: 'Enter' })
    expect(await screen.findByRole('option', { name: '超高 · xhigh' })).toBeTruthy()
  })

  it('keeps missing old snapshot values unknown and clears overrides when switching models', async () => {
    const current = task()
    current.members[0] = { ...member, reasoningEffort: 'ultra' }
    const config = settings()
    config.models.push({ ...config.models[0], id: 'second', modelId: 'gpt-5.5', name: 'GPT 5.5' })
    const onChange = mount(current, config)
    expect(screen.getByText('ultra 可由 Codex 自动委派子任务。')).toBeTruthy()
    await selectOption('执行 模型', 'GPT 5.5')
    expect(onChange.mock.calls.at(-1)?.[0].members[0].reasoningEffort).toBeUndefined()
    cleanup()
    current.runs = [run('old'), run('latest')]
    delete current.runs[0].members[0].effectiveReasoningEffort
    mount(current, config, 'old')
    expect(screen.getByRole('combobox', { name: '执行 思考强度' }).textContent).toBe('未记录')
  })

  it('renders incompatible member selections as recoverable errors instead of crashing', async () => {
    const current = task()
    current.members[0] = { ...member, reasoningEffort: 'none' }
    const onChange = mount(current)
    expect(screen.getByRole('alert').textContent).toMatch(/不支持所选思考强度/)
    await selectOption('执行 思考强度', 'Runtime 默认')
    expect(onChange.mock.calls.at(-1)?.[0].members[0].reasoningEffort).toBe('inherit')
  })

  it.each([{}, null])('renders malformed persisted effort %j as an invalid configuration instead of inheriting or crashing', async invalid => {
    const current = task()
    current.members[0] = { ...member, reasoningEffort: invalid as unknown as 'high' }
    const onChange = mount(current)
    expect(screen.getByRole('combobox', { name: '执行 思考强度' }).textContent).toBe('配置无效')
    expect(screen.getByRole('alert').textContent).toMatch(/思考强度配置无效/)
    await selectOption('执行 思考强度', 'Runtime 默认')
    expect(onChange.mock.calls.at(-1)?.[0].members[0].reasoningEffort).toBe('inherit')
  })
})

describe('composer configuration and live conversation', () => {
  it('keeps members and runs separate in both conversation and historical member views', () => {
    const current = task()
    current.mode = 'team'
    current.members = [member, { ...member, id: 'reviewer', name: 'Reviewer', role: '审查' }]
    current.runs = ['old', 'latest'].map(id => ({ ...run(id), members: current.members.map(item => ({ ...item, runtime, model: '', status: 'completed' as const })) }))
    current.messages = [
      { id: 'a', role: 'assistant', runId: 'old', memberId: member.id, text: '旧轮第一段', createdAt: current.createdAt },
      { id: 'b', role: 'assistant', runId: 'old', memberId: 'reviewer', text: '审查回复', createdAt: current.createdAt },
      { id: 'c', role: 'assistant', runId: 'old', memberId: member.id, text: '旧轮第二段', createdAt: current.createdAt },
      { id: 'd', role: 'assistant', runId: 'latest', memberId: member.id, text: '新轮回复', createdAt: current.createdAt },
    ]
    const props = { settings: settings(), onChange: vi.fn(), onSelectRun: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSettings: vi.fn(), onInspector: vi.fn(), inspectorOpen: false, onDuplicate: vi.fn() }
    const view = render(<Workbench {...props} task={current} selectedRunId="latest" />)
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(3)
    view.rerender(<Workbench {...props} task={current} selectedRunId="old" />)
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(2)
    expect(screen.queryByText('新轮回复')).toBeNull()
    fireEvent.keyDown(screen.getByRole('tab', { name: '成员会话' }), { key: 'Enter' })
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(1)
    expect(screen.getByText('旧轮第一段')).toBeTruthy()
    expect(screen.getByText('旧轮第二段')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer · 审查' }))
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(1)
    expect(screen.getByText('审查回复')).toBeTruthy()
    expect(screen.queryByText('旧轮第一段')).toBeNull()
  })

  it('appends a turn in place with one identity and footer while isolating Markdown segments', () => {
    const current = task()
    current.runs = [run('active')]
    current.runs[0].members[0].status = 'running'
    current.messages = [{ id: 'first', role: 'assistant', runId: 'active', memberId: member.id, text: '第一段\n\n```txt\n未闭合代码块', createdAt: current.createdAt }]
    const props = { settings: settings(), selectedRunId: '', onChange: vi.fn(), onSelectRun: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSettings: vi.fn(), onInspector: vi.fn(), inspectorOpen: false, onDuplicate: vi.fn() }
    const view = render(<Workbench {...props} task={current} />)
    const article = document.querySelector('.message-assistant')
    const firstPart = article?.querySelector('.message-part')
    const updated: Task = { ...current, messages: [...current.messages, { ...current.messages[0], id: 'second', text: '## 最终结果\n\n已完成。', streaming: true }] }
    view.rerender(<Workbench {...props} task={updated} />)
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(1)
    expect(document.querySelector('.message-assistant')).toBe(article)
    expect(article?.querySelector('.message-part')).toBe(firstPart)
    expect(article?.querySelectorAll('.message-heading')).toHaveLength(1)
    expect(article?.querySelectorAll('.message-foot')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '最终结果' })).toBeTruthy()
    expect(screen.getByText('正在输出…')).toBeTruthy()
    fireEvent.click(article!.querySelector('.message-foot button')!)
    expect(props.onInspector).toHaveBeenCalledOnce()
    view.rerender(<Workbench {...props} task={{ ...updated, runs: [run('active')] }} />)
    expect(article?.textContent).toContain('Runtime 输出')
    expect(article?.textContent).not.toContain('正在输出')
  })

  it('renders streamed reasoning inside the same Agent turn and keeps its disclosure stable across token updates', () => {
    const current = task()
    current.runs = [run('active')]
    current.runs[0].members[0].status = 'running'
    current.messages = [
      { id: 'thinking', role: 'assistant', kind: 'reasoning', runId: 'active', memberId: member.id, text: '先检查', createdAt: current.createdAt, streaming: true },
      { id: 'answer', role: 'assistant', kind: 'message', runId: 'active', memberId: member.id, text: '公开回答', createdAt: current.createdAt, streaming: true },
    ]
    const props = { settings: settings(), selectedRunId: '', onChange: vi.fn(), onSelectRun: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSettings: vi.fn(), onInspector: vi.fn(), inspectorOpen: false, onDuplicate: vi.fn() }
    const view = render(<Workbench {...props} task={current} />)
    const article = document.querySelector('.message-assistant')!
    const reasoning = screen.getByRole('button', { name: /思考过程/ })
    expect(document.querySelectorAll('.message-assistant')).toHaveLength(1)
    expect(reasoning.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('思考过程').textContent).toBe('先检查')
    expect(screen.getByText('公开回答')).toBeTruthy()
    expect(screen.getByText('正在输出…')).toBeTruthy()

    const updated = { ...current, messages: current.messages.map(message => message.kind === 'reasoning' ? { ...message, text: '先检查上下文。' } : message) }
    view.rerender(<Workbench {...props} task={updated} />)
    expect(document.querySelector('.message-assistant')).toBe(article)
    expect(screen.getByRole('button', { name: /思考过程/ })).toBe(reasoning)
    expect(screen.getByLabelText('思考过程').textContent).toBe('先检查上下文。')
    expect(reasoning.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps member management and viewing separate from explicitly sending to all', async () => {
    const initial = task()
    initial.mode = 'team'
    initial.members = [{ ...member, reasoningEffort: 'low' }, { ...member, id: 'reviewer', role: '审查', reasoningEffort: 'xhigh' }]
    const onChange = vi.fn()
    const onSend = vi.fn(async () => {})
    function Harness() {
      const [current, setCurrent] = useState(initial)
      return <Workbench task={current} settings={settings()} selectedRunId="" onChange={next => { onChange(next); setCurrent(next) }} onSelectRun={vi.fn()} onSend={onSend} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />
    }
    render(<Harness />)
    expect(document.querySelector('.member-roster')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^消息接收者：/ }))
    fireEvent.click(screen.getByRole('button', { name: '所有成员' }))
    fireEvent.click(screen.getByRole('button', { name: '成员与 Runtime' }))
    await selectOption('配置成员', '审查 · Codex')
    await selectOption('审查 思考强度', '中 · medium')
    const changed = onChange.mock.calls.at(-1)?.[0] as Task
    expect(changed.members[0].reasoningEffort).toBe('low')
    expect(changed.members[1].reasoningEffort).toBe('medium')
    fireEvent.keyDown(screen.getByRole('dialog', { name: '成员与 Runtime' }), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('tab', { name: '成员会话' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Codex · 审查' }))
    expect(screen.getByRole('button', { name: /^消息接收者：/ }).textContent).toContain('所有成员 · 2 人')
    fireEvent.change(screen.getByRole('textbox', { name: '任务指令' }), { target: { value: '一起完成任务' } })
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('一起完成任务', 'all'))
  })

  it('follows changes from any member at the bottom, preserves an upward scroll, and can return to latest', () => {
    const initial = task()
    initial.messages = [
      { id: 'a', role: 'assistant', text: '成员 A 输出', memberId: 'member', createdAt: initial.createdAt },
      { id: 'b', role: 'assistant', text: '成员 B 输出', memberId: 'other', createdAt: initial.createdAt },
    ]
    const props = { settings: settings(), selectedRunId: '', onChange: vi.fn(), onSelectRun: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSettings: vi.fn(), onInspector: vi.fn(), inspectorOpen: false, onDuplicate: vi.fn() }
    const view = render(<Workbench {...props} task={initial} />)
    const scroll = screen.getByLabelText('任务对话记录')
    let height = 1200
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    const updated = { ...initial, messages: initial.messages.map(message => message.id === 'a' ? { ...message, text: message.text + ' 新增第一段' } : message) }
    view.rerender(<Workbench {...props} task={updated} />)
    expect(scroll.scrollTop).toBe(1200)
    scroll.scrollTop = 100
    fireEvent.scroll(scroll)
    height = 1600
    view.rerender(<Workbench {...props} task={{ ...updated, messages: updated.messages.map(message => message.id === 'a' ? { ...message, text: message.text + ' 继续输出' } : message) }} />)
    expect(scroll.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: '回到最新' }))
    expect(scroll.scrollTop).toBe(1600)
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull()
  })

  it('shows real search activity and streaming text without marking an active answer as finished', () => {
    const current = task()
    const active = run('active')
    active.members[0].status = 'running'
    current.runs = [active]
    current.events = [{ id: 'search', taskId: current.id, runId: active.id, memberId: member.id, timestamp: '2026-09-16T00:00:03Z', kind: 'stdout', text: JSON.stringify({ type: 'item.started', item: { id: 'search-1', type: 'web_search', query: 'latest AI news' } }) + '\n' }]
    current.messages = [{ id: 'stream', role: 'assistant', text: '正在整理第一条新闻', memberId: member.id, runId: active.id, createdAt: active.createdAt, streaming: true }]
    mount(current, settings(), '', false)
    expect(screen.getByText('正在整理第一条新闻')).toBeTruthy()
    expect(screen.getByText('正在输出…')).toBeTruthy()
    expect(screen.getByLabelText('实时执行活动').textContent).toMatch(/检索网页/)
    expect(screen.getByLabelText('实时执行活动').textContent).toMatch(/latest AI news/)
    expect(screen.getByRole('button', { name: '停止当前执行' })).toBeTruthy()
  })
})

describe('instruction submission', () => {
  it('preserves edits while a request is pending and guards duplicate and IME submission', async () => {
    let resolve!: () => void
    const onSend = vi.fn(() => new Promise<void>(done => { resolve = done }))
    render(<Workbench task={task()} settings={settings()} selectedRunId="" onChange={vi.fn()} onSelectRun={vi.fn()} onSend={onSend} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '第一条指令' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('第一条指令', 'member')
    fireEvent.change(input, { target: { value: '下一条草稿' } })
    resolve()
    await waitFor(() => expect((screen.getByRole('button', { name: '发送指令' }) as HTMLButtonElement).disabled).toBe(false))
    expect(input.value).toBe('下一条草稿')
  })

  it('keeps the instruction and shows the real error when submission fails', async () => {
    render(<Workbench task={task()} settings={settings()} selectedRunId="" onChange={vi.fn()} onSelectRun={vi.fn()} onSend={async () => { throw new Error('无法保存执行快照') }} onStop={vi.fn()} onSettings={vi.fn()} onInspector={vi.fn()} inspectorOpen={false} onDuplicate={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '保留这条指令' } })
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }))
    await screen.findByText('无法保存执行快照')
    expect(input.value).toBe('保留这条指令')
  })
})
