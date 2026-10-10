// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalAssistant, GoalTaskProposals } from './GoalAssistant'
import { GoalsPage } from './GoalsPage'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { confirmGoalAssistantDraft } from '@/lib/goal-assistant'
import { createWorkspaceTask } from '@/lib/workspace'
import type { AppState } from '@/lib/types'
import type { GoalAssistantDraft } from '@/lib/goal-types'

vi.mock('@/lib/bridge', () => ({ isDesktop: true }))
vi.mock('./MarkdownMessage', () => ({ MarkdownMessage: ({ text }: { text: string }) => <div>{text}</div> }))
vi.mock('./RuntimeApprovalPanel', () => ({ RuntimeApprovalPanel: ({ task }: { task: { id: string } }) => <div aria-label="助手审批来源">{task.id}</div> }))
vi.mock('./GoalCelebration', () => ({ GoalCelebration: ({ onDismiss }: { onDismiss: () => void }) => <div role="status">目标已明确<button onClick={onDismiss}>关闭目标确认提示</button></div> }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const draft: GoalAssistantDraft = {
  title: '完成团队知识库试点', intent: '提高资料可查性', expected: '团队能够独立查到试点资料', constraints: '只处理公开项目', deadline: '2026-11-01', currentSummary: '已有文档清单',
  criteria: [{ text: '试点可查', baseline: '待验证', target: '三位同事能够找到约定资料', method: '记录独立试用结果' }],
}
function seed(): AppState {
  const state = createInitialState()
  const goal = createGoal({ title: '想把资料整理好' })
  goal.assistant = { draft: structuredClone(draft), input: '补充这条约束' }
  return { ...state, tasks: [], goals: [goal], agents: [], activeGoalId: goal.id }
}

describe('Goal assistant boundaries', () => {
  it('persists a new exploration across Goal navigation and clears it only with the saved Goal', async () => {
    const initial = seed()
    initial.goalExplorationInput = '还没提交的想法'
    let latest = initial
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} explorationRequest={1} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect((screen.getByLabelText('给目标助手的消息') as HTMLTextAreaElement).value).toBe('还没提交的想法')
    fireEvent.change(screen.getByLabelText('给目标助手的消息'), { target: { value: '新的未完成探索' } })
    await waitFor(() => expect(latest.goalExplorationInput).toBe('新的未完成探索'))
    fireEvent.click(screen.getByRole('button', { name: '打开目标：想把资料整理好' }))
    fireEvent.click(screen.getByRole('button', { name: '开始一件事' }))
    expect((screen.getByLabelText('给目标助手的消息') as HTMLTextAreaElement).value).toBe('新的未完成探索')
    fireEvent.click(screen.getByRole('button', { name: '开始整理目标' }))
    await waitFor(() => expect(latest.goals).toHaveLength(2))
    expect(latest.goalExplorationInput).toBe('')
    expect(latest.goals[0].assistant!.draft).toEqual(draft)
    expect(latest.goals[1].status).toBe('clarifying')
    expect(latest.tasks).toHaveLength(0)
  })

  it('keeps Goal conversation and persisted input separate from business Task messages', async () => {
    const initial = seed()
    const assistant = createWorkspaceTask(initial.settings, { title: '目标助手', goalId: initial.goals[0].id })
    assistant.kind = 'goal_assistant'
    assistant.messages = [{ id: 'a', role: 'assistant', text: '只属于目标的回复\n```goalward\n{"draft":null}\n```', createdAt: '' }]
    const business = createWorkspaceTask(initial.settings, { title: '业务任务', goalId: initial.goals[0].id })
    business.messages = [{ id: 'b', role: 'user', text: '业务会话不能出现在目标助手', createdAt: '' }]
    initial.tasks = [business, assistant]
    initial.goals[0].assistant!.taskId = assistant.id
    let latest = initial
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalAssistant state={state} goal={state.goals[0]} onStart={vi.fn()} onConfirm={vi.fn()} onSend={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect(screen.getByText('只属于目标的回复')).toBeTruthy()
    expect(screen.queryByText('业务会话不能出现在目标助手')).toBeNull()
    expect(screen.queryByText('{"draft":null}')).toBeNull()
    fireEvent.change(screen.getByLabelText('给目标助手的消息'), { target: { value: '保留新的目标草稿' } })
    await waitFor(() => expect(latest.goals[0].assistant!.input).toBe('保留新的目标草稿'))
    expect(latest.tasks.find(task => task.id === business.id)!.messages[0].text).toBe('业务会话不能出现在目标助手')
  })

  it.each(['business', 'other-goal'] as const)('ignores a damaged assistant reference pointing at %s history, approval, and running state', type => {
    const initial = seed(), goal = initial.goals[0]
    const foreign = createWorkspaceTask(initial.settings, { title: '不可泄露的会话', goalId: goal.id })
    if (type === 'other-goal') { foreign.kind = 'goal_assistant'; foreign.goalId = 'another-goal' }
    foreign.messages = [{ id: 'private', role: 'assistant', text: '另一个任务的私有回复', createdAt: '' }]
    foreign.historyPending = true
    foreign.runs = [{ id: 'private-run', createdAt: '', prompt: '', directory: '', members: [{ ...foreign.members[0], runtime: initial.settings.runtimes[0], model: '', status: 'running' }] }]
    initial.tasks = [foreign]
    goal.assistant!.taskId = foreign.id
    goal.assistant!.proposals = [{ id: 'p1', title: '待采用的业务任务', delivery: '结果', acceptance: '验收', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version }]
    const prepare = vi.fn()
    render(<><GoalAssistant state={initial} goal={goal} onStart={vi.fn()} onConfirm={vi.fn()} onChange={vi.fn()} onPrepare={prepare} onStop={vi.fn()} /><GoalTaskProposals state={initial} goal={goal} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} /></>)
    expect(screen.queryByText('另一个任务的私有回复')).toBeNull()
    expect(screen.queryByLabelText('助手审批来源')).toBeNull()
    expect(screen.queryByRole('button', { name: '停止目标助手' })).toBeNull()
    expect(screen.queryByText('目标助手正在处理…')).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '确认目标并安排任务' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '采用' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('uses the current formal definition after manual Goal and context revisions, then confirms without restoring the old draft', async () => {
    const initial = seed()
    let latest = confirmGoalAssistantDraft(initial, initial.goals[0].id)
    const send = vi.fn(async () => {})
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '修订' }))
    const definition = screen.getByRole('dialog')
    fireEvent.change(within(definition).getByLabelText('目标名称'), { target: { value: '当前正式目标' } })
    fireEvent.change(within(definition).getByLabelText('预期结果'), { target: { value: '当前正式结果' } })
    fireEvent.change(within(definition).getByLabelText('期望日期（可选）'), { target: { value: '2026-11-03' } })
    fireEvent.change(within(definition).getByLabelText('本次修订原因'), { target: { value: '手动核对最新需求' } })
    fireEvent.click(within(definition).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '更新现状' }))
    const context = screen.getByRole('dialog')
    fireEvent.change(within(context).getByLabelText('整体描述'), { target: { value: '刚手动补充的现状' } })
    fireEvent.change(within(context).getByLabelText('变化原因'), { target: { value: '新证据' } })
    fireEvent.click(within(context).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '目标助手' }))
    expect((screen.getByLabelText('目标名称') as HTMLInputElement).value).toBe('当前正式目标')
    expect((screen.getByLabelText('预期结果') as HTMLTextAreaElement).value).toBe('当前正式结果')
    expect((screen.getByLabelText('期望日期（可选）') as HTMLInputElement).value).toBe('2026-11-03')
    expect((screen.getByLabelText('当前现状') as HTMLTextAreaElement).value).toBe('刚手动补充的现状')
    fireEvent.change(screen.getByLabelText('范围与约束'), { target: { value: '用户新改的约束' } })
    await waitFor(() => expect(latest.goals[0].assistant!.draftGoalVersion).toBe(latest.goals[0].version))
    expect(latest.goals[0].assistant!.draftStateVersion).toBe(latest.goals[0].currentState.version)
    fireEvent.click(screen.getByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(latest.goals[0]).toMatchObject({ title: '当前正式目标', expected: '当前正式结果', deadline: '2026-11-03', constraints: '用户新改的约束' })
    expect(latest.goals[0].currentState.summary).toBe('刚手动补充的现状')
  })

  it.each(['goal', 'context'] as const)('refuses a draft edit if its displayed %s version changed before the write', async kind => {
    const initial = seed()
    let latest = structuredClone(initial)
    if (kind === 'goal') latest.goals[0].version += 1
    else latest.goals[0].currentState.version += 1
    const previousDraft = structuredClone(latest.goals[0].assistant!.draft)
    render(<GoalAssistant state={initial} goal={initial.goals[0]} onStart={vi.fn()} onConfirm={vi.fn()} onChange={async reducer => { latest = reducer(latest) }} />)
    fireEvent.change(screen.getByLabelText('目标名称'), { target: { value: '不允许覆盖的旧视图编辑' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目标或现状已更新'))
    expect(latest.goals[0].assistant!.draft).toEqual(previousDraft)
  })

  it('preserves detailed criteria and acceptance when the overview editor only changes a name or date', async () => {
    let latest = seed()
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    latest.goals[0].criteria[0] = { ...latest.goals[0].criteria[0], status: 'satisfied', evidence: '同事试用记录' }
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalsPage state={state} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '修订' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('目标名称'), { target: { value: '知识库试点改名' } })
    fireEvent.change(within(dialog).getByLabelText('期望日期（可选）'), { target: { value: '2026-11-02' } })
    fireEvent.change(within(dialog).getByLabelText('本次修订原因'), { target: { value: '调整名称和日期' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(latest.goals[0].title).toBe('知识库试点改名'))
    expect(latest.goals[0].criteria[0]).toMatchObject({ ...draft.criteria[0], status: 'satisfied', evidence: '同事试用记录' })
  })

  it('reads back the exact standard and verification method when opening a criterion from its progress chart', () => {
    const initial = seed()
    const state = confirmGoalAssistantDraft(initial, initial.goals[0].id)
    render(<GoalsPage state={state} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} />)
    expect(screen.queryByText(draft.criteria[0].target)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '试点可查：待验证' }))
    const dialog = screen.getByRole('dialog', { name: '检查成功条件' })
    expect(within(dialog).getByText(draft.criteria[0].target)).toBeTruthy()
    expect(within(dialog).getByText(draft.criteria[0].method)).toBeTruthy()
    expect(within(dialog.querySelector('dl')!).getByText(draft.criteria[0].baseline)).toBeTruthy()
    expect(within(dialog).getByLabelText('验收依据')).toBeTruthy()
  })

  it('commits confirmation before celebration and automatic plan, and preserves a confirmed goal when plan fails', async () => {
    const initial = seed()
    let latest = initial
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => { throw new Error('Runtime 启动失败') })
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} selectedGoalId={initial.goals[0].id} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => { await gate; latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    expect(screen.queryByText('目标已明确')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(screen.getByText('目标已明确')).toBeTruthy())
    await waitFor(() => expect(send).toHaveBeenCalledWith(initial.goals[0].id, expect.any(String), 'plan', expect.any(String)))
    expect(latest.goals[0].status).toBe('active')
    expect(latest.tasks).toHaveLength(0)
    expect(screen.getByRole('tab', { name: '任务 0' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Runtime 启动失败')
    expect(screen.getByRole('button', { name: '重新提议' })).toBeTruthy()
    cleanup()
    render(<GoalsPage state={latest} onChange={vi.fn()} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} />)
    expect(screen.queryByText('目标已明确')).toBeNull()
  })

  it('does not celebrate or dispatch a plan when confirmation persistence fails', async () => {
    const initial = seed(), send = vi.fn()
    render(<GoalsPage state={initial} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async () => { throw new Error('保存失败') }} />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存失败'))
    expect(screen.queryByText('目标已明确')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect((screen.getByLabelText('预期结果') as HTMLTextAreaElement).value).toBe(draft.expected)
  })

  it('rolls back an optimistic failed confirmation so retry must commit before it can plan', async () => {
    const initial = seed(), send = vi.fn(async () => {})
    let latest = initial, failNext = true
    function Harness() {
      const [state, setState] = useState(initial)
      return <GoalsPage state={state} viewRequest={{ goalId: initial.goals[0].id, tab: 'assistant', request: 1 }} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onOpenAgent={vi.fn()} onSendAssistant={send} onChange={async reducer => {
        latest = reducer(latest); setState(latest)
        if (failNext) { failNext = false; throw new Error('第一次持久化失败') }
      }} />
    }
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('第一次持久化失败'))
    expect(latest.goals[0].assistant!.confirmedVersion).toBeUndefined()
    expect(latest.goals[0].version).toBe(initial.goals[0].version)
    expect(screen.queryByText('目标已明确')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认目标并安排任务' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(latest.goals[0].assistant!.confirmedVersion).toBe(latest.goals[0].version)
  })

  it('keeps suggestions outside business Tasks until adoption and allows prerequisite adoption together', async () => {
    let latest = seed()
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    const goal = latest.goals[0]
    goal.assistant!.proposals = [
      { id: 'p1', title: '整理清单', delivery: '可读文档清单', acceptance: '包含试点资料', deadline: '2026-10-20', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
      { id: 'p2', title: '同事试用', delivery: '试用记录', acceptance: '记录找资料结果', deadline: '2026-10-30', dependsOn: ['p1'], status: 'suggested', baseGoalVersion: goal.version },
    ]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    expect(latest.tasks).toHaveLength(0)
    fireEvent.click(screen.getAllByRole('button', { name: '采用' })[1])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('先采用前置任务'))
    expect(latest.tasks).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('任务建议名称：p1'), { target: { value: '用户修订的清单任务' } })
    expect(latest.goals[0].assistant!.proposals![0].edited).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '采用全部 2' }))
    await waitFor(() => expect(latest.tasks).toHaveLength(2))
    const first = latest.tasks.find(task => task.title === '用户修订的清单任务')!
    expect(latest.tasks.find(task => task.title === '同事试用')!.dependencies).toEqual([first.id])
    expect(latest.tasks.every(task => !task.runs.length)).toBe(true)
    expect(screen.queryByRole('button', { name: '采用全部 2' })).toBeNull()
  })

  it('rolls back optimistic adoption failure and retry creates one durable Task', async () => {
    let latest = seed(), failNext = true
    latest = confirmGoalAssistantDraft(latest, latest.goals[0].id)
    latest.goals[0].assistant!.proposals = [{ id: 'p1', title: '清单任务', delivery: '可读清单', acceptance: '含试点资料', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: latest.goals[0].version }]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => {
        latest = reducer(latest); setState(latest)
        if (failNext) { failNext = false; throw new Error('采用保存失败') }
      }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '采用' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('采用保存失败'))
    expect(latest.tasks).toHaveLength(0)
    expect(latest.goals[0].assistant!.proposals![0].status).toBe('suggested')
    fireEvent.click(screen.getByRole('button', { name: '采用' }))
    await waitFor(() => expect(latest.tasks).toHaveLength(1))
    expect(latest.goals[0].assistant!.proposals![0].taskId).toBe(latest.tasks[0].id)
    expect(screen.getByText('已采用')).toBeTruthy()
  })

  it('marks manual dependency changes so subsequent plan generation can preserve the edited suggestion', async () => {
    let latest = seed()
    const goal = latest.goals[0]
    goal.assistant!.proposals = [
      { id: 'p1', title: '上游任务', delivery: '上游结果', acceptance: '上游验收', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
      { id: 'p2', title: '下游任务', delivery: '下游结果', acceptance: '下游验收', deadline: '', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version },
    ]
    function Harness() {
      const [state, setState] = useState(latest)
      return <GoalTaskProposals state={state} goal={state.goals[0]} onCreateTask={vi.fn()} onOpenTask={vi.fn()} onChange={async reducer => { latest = reducer(latest); setState(latest) }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getAllByRole('button', { name: '交付、验收与依赖' })[1])
    fireEvent.click(await screen.findByRole('checkbox', { name: '依赖：下游任务 → 上游任务' }))
    await waitFor(() => expect(latest.goals[0].assistant!.proposals![1]).toMatchObject({ edited: true, dependsOn: ['p1'] }))
    expect(latest.goals[0].assistant!.proposals![0].edited).toBeUndefined()
  })
})
