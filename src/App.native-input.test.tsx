// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import { createWorkspaceTask } from './lib/workspace'
import type { AppState, RuntimeEvent, StartRequest } from './lib/types'
import type { GoalsPageProps } from './components/GoalsPage'

const bridge = vi.hoisted(() => ({ isDesktop: true, activeRuntimeTurns: vi.fn(async () => []), loadState: vi.fn(), saveState: vi.fn(), loadTaskHistory: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), appendRunInput: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn(), ensureGoalAssistantDirectory: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/GoalsPage', () => ({ GoalsPage: ({ state, onOpenTask }: GoalsPageProps) => <button onClick={() => onOpenTask(state.tasks[0].id)}>Open input verification task</button> }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))

let stored: AppState, emit: (event: RuntimeEvent) => void
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const initial = createInitialState()
  const task = createWorkspaceTask(initial.settings, { title: 'Append message verification', workingDirectories: ['/project'] })
  stored = { ...initial, goals: [], tasks: [task], activeTaskId: task.id, onboarding: { version: 1, completedAt: task.createdAt, outcome: 'configured' } }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (value: AppState) => { stored = structuredClone(value) })
  bridge.loadTraceEvents.mockResolvedValue([]); bridge.loadTaskHistory.mockResolvedValue([])
  bridge.onRuntimeEvent.mockImplementation(async handler => { emit = handler; return () => {} })
  bridge.startRun.mockImplementation(async (request: StartRequest) => {
    emit({ id: crypto.randomUUID(), taskId: request.taskId, runId: request.runId, memberId: request.memberId, timestamp: new Date().toISOString(), kind: 'stdout', text: JSON.stringify({ type: 'runtime.capabilities', steer: true, followUp: false, approvals: true }) + '\n' })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('preserves rejected native input, waits for acknowledgement and records only the confirmed message', async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open input verification task' }))
  const input = await screen.findByRole('textbox', { name: '任务指令' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Start the current turn' } })
  fireEvent.click(screen.getByRole('button', { name: '发送指令' }))
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledOnce())
  await waitFor(() => expect(input.value).toBe(''))
  bridge.appendRunInput.mockRejectedValueOnce(new Error('The native session rejected the appended message'))
  fireEvent.change(input, { target: { value: 'Check tests first' } })
  fireEvent.click(screen.getByRole('button', { name: '追加消息' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The native session rejected the appended message'))
  expect(input.value).toBe('Check tests first')
  expect(stored.tasks[0].messages.filter(message => message.role === 'user')).toHaveLength(1)
  let acknowledge!: () => void
  bridge.appendRunInput.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '追加消息' }))
  await waitFor(() => expect(bridge.appendRunInput).toHaveBeenCalledTimes(2))
  expect(input.value).toBe('Check tests first')
  expect(stored.tasks[0].messages.filter(message => message.role === 'user')).toHaveLength(1)
  acknowledge()
  await waitFor(() => expect(input.value).toBe(''))
  expect(stored.tasks[0].messages.filter(message => message.role === 'user')).toHaveLength(2)
  expect(stored.tasks[0].runs).toHaveLength(1)
  expect(stored.tasks[0].runs[0].members[0].status).toBe('running')
})
