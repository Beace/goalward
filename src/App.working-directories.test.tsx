// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import { createGoal } from './lib/goals'
import { createWorkspaceTask } from './lib/workspace'
import type { AppState, StartRequest, Task } from './lib/types'
import type { GoalsPageProps } from './components/GoalsPage'

const bridge = vi.hoisted(() => ({ isDesktop: true, activeRuntimeTurns: vi.fn(async () => []), loadState: vi.fn(), saveState: vi.fn(), loadTaskHistory: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), appendRunInput: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(), ensureGoalAssistantDirectory: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/GoalsPage', () => ({ GoalsPage: ({ state, onCreateTask }: GoalsPageProps) => <section><button onClick={() => onCreateTask(state.goals[0].id)}>Create a task for the goal</button></section> }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))
vi.mock('@/components/Workbench', () => ({ Workbench: ({ task, operations, onDuplicate, onSend }: { task: Task; operations: ReactNode; onDuplicate: () => void; onSend: (prompt: string, recipient: string) => Promise<void> }) => <section aria-label="Directory test workbench"><span>{task.title}</span><button onClick={onDuplicate}>Duplicate current task</button><button onClick={() => void onSend('Directory verification request', 'all')}>Run directory verification</button>{operations}</section> }))

let stored: AppState
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  stored = createInitialState()
  const goal = { ...createGoal({ title: 'Goal with a fixed project' }), workingDirectories: ['/project/main', '/project/data'] }
  const task = createWorkspaceTask(stored.settings, { title: 'Parent task', goalId: goal.id, workingDirectories: goal.workingDirectories })
  stored = { ...stored, goals: [goal], tasks: [task], activeGoalId: goal.id, activeTaskId: task.id, onboarding: { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' } }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (value: AppState) => { stored = structuredClone(value) })
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.loadTaskHistory.mockResolvedValue([])
  bridge.onRuntimeEvent.mockResolvedValue(() => {})
  bridge.ensureGoalAssistantDirectory.mockImplementation(async (scope: string) => `/app/workspaces/${scope}`)
  bridge.startRun.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
async function createDialogTask(title: string) {
  const dialog = await screen.findByRole('dialog', { name: '新建任务' })
  expect(within(dialog).queryByRole('textbox', { name: /目录|directory/i })).toBeNull()
  fireEvent.change(within(dialog).getByLabelText('任务目标'), { target: { value: title } })
  fireEvent.click(within(dialog).getByRole('button', { name: '创建任务' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  return stored.tasks.find(task => task.title === title)!
}

describe('workspace inheritance through task creation and native dispatch', () => {
  it('creates, duplicates and creates a subtask without directory entry, then records all roots in the native Run', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create a task for the goal' }))
    const created = await createDialogTask('New goal task')
    expect(created).toMatchObject({ goalId: stored.goals[0].id, directory: '/project/main', workingDirectories: ['/project/main', '/project/data'] })
    expect(bridge.ensureGoalAssistantDirectory).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate current task' }))
    const copy = await createDialogTask('Goal copy')
    expect(copy.workingDirectories).toEqual(['/project/main', '/project/data'])
    expect(copy.goalId).toBe(created.goalId)
    fireEvent.click(screen.getByRole('button', { name: '子任务' }))
    const child = await createDialogTask('Child task inheriting directories')
    expect(child).toMatchObject({ parentTaskId: copy.id, goalId: copy.goalId, workingDirectories: copy.workingDirectories })
    fireEvent.click(screen.getByRole('button', { name: 'Run directory verification' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    const request: StartRequest = bridge.startRun.mock.calls[0][0]
    expect(request).toMatchObject({ directory: '/project/main', additionalDirectories: ['/project/data'] })
    const run = stored.tasks.find(task => task.id === child.id)!.runs[0]
    expect(run.directory).toBe('/project/main')
    expect(run.workingDirectories).toEqual(['/project/main', '/project/data'])
  })

  it('creates one fixed goal fallback when no directory was chosen, and reuses it for subsequent tasks', async () => {
    stored.goals[0].workingDirectories = []
    stored.tasks = []; stored.activeTaskId = ''
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create a task for the goal' }))
    const task = await createDialogTask('Automatic directory task')
    expect(bridge.ensureGoalAssistantDirectory).toHaveBeenCalledWith(stored.goals[0].id)
    const roots = [`/app/workspaces/${stored.goals[0].id}`]
    expect(stored.goals[0].workingDirectories).toEqual(roots)
    expect(task.workingDirectories).toEqual(roots)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate current task' }))
    const second = await createDialogTask('Reuse automatic directory')
    expect(second.workingDirectories).toEqual(roots)
    expect(bridge.ensureGoalAssistantDirectory).toHaveBeenCalledTimes(1)
  })

  it('creates a standalone fixed fallback without requiring a path and reuses it on dispatch', async () => {
    stored.settings.defaultDirectory = ''
    render(<App />)
    const navigation = await screen.findByRole('navigation', { name: '工作空间导航' })
    fireEvent.click(within(navigation).getByRole('button', { name: /^任务\s*\d+/ }))
    fireEvent.click(await screen.findByRole('button', { name: '创建任务' }))
    const task = await createDialogTask('Independent automatic directory')
    expect(task.goalId).toBeUndefined()
    expect(task.directory).toMatch(/^\/app\/workspaces\/task-/)
    expect(task.workingDirectories).toEqual([task.directory])
    fireEvent.click(screen.getByRole('button', { name: 'Run directory verification' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    expect(bridge.startRun.mock.calls[0][0].directory).toBe(task.directory)
    expect(bridge.ensureGoalAssistantDirectory).toHaveBeenCalledTimes(1)
  })
})
