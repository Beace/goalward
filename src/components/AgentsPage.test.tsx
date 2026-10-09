// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from './AgentsPage'
import { AgentMemberActions } from './AgentMemberActions'
import { createAgentProfile, memberFromAgent, updateAgentProfile } from '@/lib/agent-profiles'
import type { AppState, Settings } from '@/lib/types'

const settings: Settings = { runtimes: [{ id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: '' }], models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', defaultDirectory: '', maxParallel: 3, outputLimit: 65536 }
const empty = (): AppState => ({ version: 2, settings: structuredClone(settings), tasks: [], agents: [], goals: [], activeTaskId: '' })
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('Agents page', () => {
  it('creates an actual profile, saves a new version and starts an independent task using the saved profile', async () => {
    const onCreateTask = vi.fn(), changed = vi.fn()
    function Harness() { const [state, setState] = useState(empty); return <AgentsPage state={state} onChange={async reducer => { setState(current => { const next = reducer(current); changed(next); return next }) }} onCreateTask={onCreateTask} onOpenTask={vi.fn()} onSettings={vi.fn()} /> }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '研究助手' } })
    fireEvent.change(screen.getByLabelText('职责指令'), { target: { value: '检查官方资料' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 Agent' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('heading', { name: /研究助手.*v1/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('职责指令'), { target: { value: '检查官方资料并记录依据' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByRole('heading', { name: /研究助手.*v2/ })
    const latest: AppState = changed.mock.calls.at(-1)![0]
    expect(latest.agents[0].instructions).toBe('检查官方资料并记录依据')
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    fireEvent.click(screen.getByRole('button', { name: '继续配置任务' }))
    expect(onCreateTask).toHaveBeenCalledWith(latest.agents[0].id, undefined)
  })

  it('preserves drafts across selection, supports filtering, and never equates enabled with running', () => {
    const state = empty(); state.agents = [createAgentProfile(settings, { name: '研究' }), createAgentProfile(settings, { name: '实现' })]
    render(<AgentsPage state={state} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onSettings={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '未保存的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '选择 Agent 实现' }))
    fireEvent.click(screen.getByRole('button', { name: '选择 Agent 研究' }))
    expect((screen.getByLabelText('说明') as HTMLTextAreaElement).value).toBe('未保存的草稿')
    expect(screen.getAllByText('0 个活动执行').length).toBe(2)
    fireEvent.change(screen.getByLabelText('搜索 Agent'), { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的 Agent。')).toBeTruthy()
  })

  it('shows persistence failure without dismissing the creation dialog', async () => {
    render(<AgentsPage state={empty()} onChange={async () => { throw new Error('磁盘不可写') }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Agent' } })
    fireEvent.click(screen.getByRole('button', { name: '创建 Agent' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '磁盘不可写')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('task member profile commands', () => {
  it('applies an explicit profile update while retaining task overrides and the active execution snapshot', async () => {
    const profile = createAgentProfile(settings, { name: 'Agent', instructions: 'base' })
    const member = { ...memberFromAgent(profile), instructions: 'task override' }
    const state = empty(); state.agents = [updateAgentProfile(profile, { name: 'Renamed', instructions: 'new' }, settings)]
    state.tasks = [{ id: 't', title: 'Task', directory: '', mode: 'solo', members: [member], messages: [], events: [], createdAt: '', runs: [{ id: 'r', createdAt: '', directory: '', prompt: 'prompt', members: [{ ...member, runtime: settings.runtimes[0], model: '', status: 'running' }] }] }]
    let updated = state
    render(<AgentMemberActions state={state} task={state.tasks[0]} memberId={member.id} onChange={async reducer => { updated = reducer(state) }} />)
    expect((screen.getByRole('button', { name: '添加已有 Agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '应用 v2' }))
    await screen.findByText('已应用 v2，保留任务内覆盖；下次执行生效。')
    expect(updated.tasks[0].members[0]).toMatchObject({ name: 'Renamed', instructions: 'task override', agentProfileVersion: 2 })
    expect(updated.tasks[0].runs).toBe(state.tasks[0].runs)
  })
})
