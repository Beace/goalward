// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TracePanel } from './TracePanel'
import type { Run, RuntimeEvent, Task } from '@/lib/types'

afterEach(cleanup)
const run: Run = {
  id: 'run', createdAt: '2026-09-16T03:18:12Z', prompt: 'search', directory: '/tmp',
  members: [{ id: 'member', name: 'Codex', role: '执行', runtimeId: 'codex', modelId: '', model: '', status: 'completed', runtime: { id: 'codex', name: 'Codex', adapter: 'codex', executable: 'codex', enabled: true, args: [], defaultModel: '', description: '' } }],
}
function event(id: string, kind: RuntimeEvent['kind'], text: string): RuntimeEvent {
  return { id, kind, text, taskId: 'task', runId: run.id, memberId: 'member', timestamp: run.createdAt }
}
function task(events: RuntimeEvent[]): Task {
  return { id: 'task', title: '测试', directory: '/tmp', mode: 'solo', members: run.members, messages: [], runs: [run], events, createdAt: run.createdAt }
}
const search = JSON.stringify({ type: 'item.started', item: { id: 'search', type: 'web_search', query: 'agent runtime' } }) + '\n'
const failure = JSON.stringify({ type: 'item.completed', item: { id: 'error', type: 'error', message: 'Search temporarily unavailable' } }) + '\n'

describe('trace inspector', () => {
  it('keeps new and streaming rows collapsed and releases details after closing', async () => {
    const events = [event('search', 'stdout', search)]
    const view = render(<TracePanel task={task(events)} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /网页搜索/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('.trace-detail')).toBeNull()
    view.rerender(<TracePanel task={task([...events, event('next', 'stderr', '新记录')])} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(view.container.querySelector('.trace-detail')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('region', { name: '入参' })).toBeTruthy()
    fireEvent.click(trigger)
    await waitFor(() => expect(view.container.querySelector('.trace-detail')).toBeNull())
    fireEvent.click(trigger)
    expect(screen.getByRole('region', { name: '入参' }).textContent).toContain('agent runtime')
  })
  it('mounts only a window of a long trace and retains the full record count during streaming', () => {
    const events = Array.from({ length: 1000 }, (_, index) => event(`diagnostic-${index}`, 'stderr', `诊断记录 ${index}`))
    const view = render(<TracePanel task={task(events)} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByText('1000 条记录')).toBeTruthy()
    const mounted = view.container.querySelectorAll('.trace-event').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(25)
    expect(view.container.querySelectorAll('.trace-raw-record')).toHaveLength(0)
    const first = view.container.querySelector('.trace-trigger')!
    fireEvent.click(first)
    view.rerender(<TracePanel task={task([...events, event('next', 'stderr', '继续输出')])} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByText('1001 条记录')).toBeTruthy()
    expect(view.container.querySelector('.trace-trigger')).toBe(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelectorAll('.trace-event').length).toBeLessThan(25)
    expect(view.container.querySelector('[role=listitem]')?.getAttribute('aria-setsize')).toBe('1001')
  })

  it('updates a single Kimi reply in place, copies the complete text and paginates raw records', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const kimi: Run = { ...run, members: run.members.map(member => ({ ...member, status: 'running', runtime: { ...member.runtime, adapter: 'kimi' } })) }
    const chunks = Array.from({ length: 121 }, (_, index) => event(`chunk-${index}`, 'stdout', JSON.stringify({ type: 'kimi.acp.update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `片段${index}\n` } } }) + '\n'))
    const initial = { ...task(chunks.slice(0, 120)), runs: [kimi] }
    const view = render(<TracePanel task={initial} run={kimi} onClose={vi.fn()} onExport={vi.fn()} />)
    const original = screen.getByRole('button', { name: /生成回复/ })
    expect(original.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('.trace-detail')).toBeNull()
    fireEvent.click(original)
    expect(view.container.querySelectorAll('.trace-raw-record')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /原始记录/ }))
    expect(view.container.querySelectorAll('.trace-raw-record')).toHaveLength(50)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    view.rerender(<TracePanel task={{ ...initial, events: chunks }} run={kimi} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByRole('button', { name: /生成回复/ })).toBe(original)
    expect(screen.getByText('51–100 / 121')).toBeTruthy()
    expect(screen.getByText('1 条记录')).toBeTruthy()
    expect(screen.getByText('1 项执行中')).toBeTruthy()
    expect(view.container.querySelectorAll('.trace-raw-record')).toHaveLength(50)
    fireEvent.click(screen.getByRole('button', { name: '复制完整回复内容' }))
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(chunks.map((_, index) => `片段${index}\n`).join('')))
    fireEvent.click(screen.getAllByRole('button', { name: '复制事件输出' })[0])
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(chunks[50].text))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(view.container.querySelectorAll('.trace-raw-record')).toHaveLength(21)
    expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
  })

  it('labels protocol events by type and phase and retains original copyable output', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    render(<TracePanel task={task([event('search-event', 'stdout', search)])} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByText('网页搜索')).toBeTruthy()
    expect(screen.getByText('未完成')).toBeTruthy()
    expect(screen.queryByText('标准输出 / 公开事件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /网页搜索/ }))
    fireEvent.click(screen.getByRole('button', { name: /原始记录/ }))
    expect(screen.getByText(/item.started.*web_search/, { selector: '.trace-protocol' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制事件输出' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(search))
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('filters structured errors on stdout without treating all stderr as an error', () => {
    render(<TracePanel task={task([event('notice', 'stderr', 'Reading additional input from stdin...\n'), event('search', 'stdout', search), event('failure', 'stdout', failure)])} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '仅显示错误' }))
    expect(screen.getByText('1 条记录')).toBeTruthy()
    expect(screen.queryByText('网页搜索')).toBeNull()
    expect(screen.queryByText('诊断输出')).toBeNull()
    expect(screen.getByText('失败')).toBeTruthy()
  })

  it('shows an accurate empty filter state and preserves export and close actions', () => {
    const onClose = vi.fn(), onExport = vi.fn()
    render(<TracePanel task={task([event('notice', 'stderr', 'Reading additional input from stdin...\n')])} run={run} onClose={onClose} onExport={onExport} />)
    fireEvent.click(screen.getByRole('button', { name: '仅显示错误' }))
    expect(screen.getByText('没有错误事件')).toBeTruthy()
    expect(screen.queryByText('等待执行事件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '导出聊天与执行过程' }))
    fireEvent.click(screen.getByRole('button', { name: '收起检查器' }))
    expect(onExport).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('updates a fragmented event in place without closing its expanded details', () => {
    const cut = search.indexOf('web_search') + 4
    const first = event('first', 'stdout', search.slice(0, cut))
    const running: Run = { ...run, members: run.members.map(member => ({ ...member, status: 'running' })) }
    const initial = { ...task([first]), runs: [running] }
    const view = render(<TracePanel task={initial} run={running} onClose={vi.fn()} onExport={vi.fn()} />)
    fireEvent.click(view.container.querySelector('.trace-trigger')!)
    const originalTrigger = screen.getByRole('button', { expanded: true })
    view.rerender(<TracePanel task={{ ...initial, events: [first, event('second', 'stdout', search.slice(cut))] }} run={running} onClose={vi.fn()} onExport={vi.fn()} />)
    const currentTrigger = screen.getByRole('button', { expanded: true })
    expect(currentTrigger).toBe(originalTrigger)
    expect(within(currentTrigger).getByText('网页搜索')).toBeTruthy()
    expect(screen.getByText('1 条记录')).toBeTruthy()
    expect(screen.getByRole('region', { name: '入参' }).textContent).toContain('agent runtime')
    fireEvent.click(screen.getByRole('button', { name: /原始记录/ }))
    expect(JSON.parse(view.container.querySelector('.trace-raw-record pre')?.textContent ?? '')).toEqual(JSON.parse(search))
  })

  it('keeps one expanded invocation while its input, loading status and output update', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const start = event('start', 'stdout', JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'printf hello', status: 'in_progress' } }) + '\n')
    const running: Run = { ...run, members: run.members.map(member => ({ ...member, status: 'running' })) }
    const current = { ...task([start]), runs: [running] }
    const view = render(<TracePanel task={current} run={running} onClose={vi.fn()} onExport={vi.fn()} />)
    fireEvent.click(view.container.querySelector('.trace-trigger')!)
    const trigger = screen.getByRole('button', { expanded: true })
    expect(within(trigger).getByText('执行中')).toBeTruthy()
    expect(view.container.querySelector('.trace-loading')).toBeTruthy()
    expect(screen.getByRole('region', { name: '出参' }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('region', { name: '入参' }).textContent).toContain('printf hello')
    const done = { ...event('done', 'stdout', JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'printf hello', aggregated_output: 'hello', exit_code: 0 } }) + '\n'), timestamp: '2026-09-16T03:18:15Z' }
    view.rerender(<TracePanel task={{ ...current, events: [start, done] }} run={running} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByRole('button', { expanded: true })).toBe(trigger)
    expect(screen.getAllByText('执行命令')).toHaveLength(1)
    expect(screen.getByText('1 条记录')).toBeTruthy()
    expect(within(trigger).getByText('完成')).toBeTruthy()
    expect(view.container.querySelector('.trace-loading')).toBeNull()
    expect(screen.getByRole('region', { name: '出参' }).getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('region', { name: '出参' }).textContent).toContain('hello')
    expect(trigger.textContent).toContain('3.0 s')
    fireEvent.click(screen.getByRole('button', { name: '复制入参' }))
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1))
    expect(copy.mock.calls[0][0]).toContain('printf hello')
    fireEvent.click(screen.getByRole('button', { name: '复制出参' }))
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(2))
    expect(copy.mock.calls[1][0]).toContain('hello')
    fireEvent.click(screen.getByRole('button', { name: /原始记录/ }))
    const rawCopies = screen.getAllByRole('button', { name: '复制事件输出' })
    fireEvent.click(rawCopies[0])
    await waitFor(() => expect(copy).toHaveBeenCalledWith(start.text))
    fireEvent.click(rawCopies[1])
    await waitFor(() => expect(copy).toHaveBeenCalledWith(done.text))
  })

  it('keeps the failed invocation and its input together when errors are filtered', () => {
    const entries = [
      event('start', 'stdout', JSON.stringify({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'false' } }) + '\n'),
      event('end', 'stdout', JSON.stringify({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'false', exit_code: 1, aggregated_output: 'command failed' } }) + '\n'),
    ]
    render(<TracePanel task={task(entries)} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '仅显示错误' }))
    expect(screen.getByText('1 条记录')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /执行命令/ }))
    expect(screen.getByRole('region', { name: '入参' }).textContent).toContain('false')
    expect(screen.getByRole('region', { name: '出参' }).textContent).toContain('command failed')
  })

  it('does not fabricate search output from completed query metadata', () => {
    const completed = event('end', 'stdout', JSON.stringify({ type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'agent runtime', action: { type: 'search', queries: ['agent runtime'] } } }) + '\n')
    render(<TracePanel task={task([event('start', 'stdout', search), completed])} run={run} onClose={vi.fn()} onExport={vi.fn()} />)
    expect(screen.getByText('1 条记录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /网页搜索/ }))
    expect(screen.getByRole('region', { name: '入参' }).textContent).toContain('agent runtime')
    expect(screen.getByRole('region', { name: '出参' }).textContent).not.toContain('agent runtime')
    expect(screen.queryByRole('button', { name: '复制出参' })).toBeNull()
  })
})
