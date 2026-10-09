// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState, createTask } from './lib/domain'
import type { AppState, RuntimeEvent, Settings, StartRequest } from './lib/types'

const bridge = vi.hoisted(() => ({ isDesktop: true, loadState: vi.fn(), saveState: vi.fn(), loadTraceEvents: vi.fn(), onRuntimeEvent: vi.fn(), discoverLocalEnvironment: vi.fn(), chooseDirectory: vi.fn(), chooseFile: vi.fn(), exportTask: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), probeRuntime: vi.fn(), storageInfo: vi.fn() }))
vi.mock('@/lib/bridge', () => bridge)
vi.mock('@/components/Workbench', () => ({ Workbench: ({ onSend }: { onSend: (prompt: string, recipient: string) => Promise<void> }) => <button onClick={() => { void onSend('test prompt', '').catch(() => {}) }}>测试执行</button> }))
vi.mock('@/components/TracePanel', () => ({ TracePanel: () => null }))
vi.mock('@/components/SettingsPage', () => ({ default: ({ settings, onSave, onBack }: { settings: Settings; onSave: (settings: Settings) => Promise<void>; onBack: () => void }) => <><button onClick={() => { const next = structuredClone(settings); next.runtimes[0].permissions = { codex: { sandbox: 'workspace-write', network: 'deny', additionalDirectories: ['/tmp'] } }; void onSave(next).then(onBack) }}>保存新的权限</button><button onClick={() => { const next = structuredClone(settings); next.models[0].reasoningEffort = 'low'; void onSave(next).then(onBack) }}>保存新的思考强度</button></> }))
vi.mock('@/components/ui/resizable', () => ({ ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }))

let stored: AppState
let emit: (event: RuntimeEvent) => void
beforeEach(() => {
  vi.resetAllMocks()
  stored = createInitialState()
  stored.settings.runtimes[0].permissions = { codex: { sandbox: 'read-only', network: 'inherit', additionalDirectories: [] } }
  stored.tasks = [createTask(stored.settings, 'permissions fixture', '/tmp', 'solo')]
  stored.activeTaskId = stored.tasks[0].id
  stored.onboarding = { version: 1, completedAt: '2026-09-16T00:00:00Z', outcome: 'configured' }
  bridge.loadState.mockImplementation(async () => structuredClone(stored))
  bridge.saveState.mockImplementation(async (value: AppState) => { stored = structuredClone(value) })
  bridge.loadTraceEvents.mockResolvedValue([])
  bridge.onRuntimeEvent.mockImplementation(async (callback: typeof emit) => { emit = callback; return () => {} })
  bridge.startRun.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('permission settings reach native execution snapshots', () => {
  it('uses saved permissions for the next run while preserving an active and historical run', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    const first: StartRequest = bridge.startRun.mock.calls[0][0]
    expect(first.runtime.permissions?.codex?.sandbox).toBe('read-only')
    fireEvent.click(screen.getByRole('button', { name: /^设置$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '保存新的权限' }))
    await screen.findByRole('button', { name: '测试执行' })
    expect(stored.settings.runtimes[0].permissions?.codex?.sandbox).toBe('workspace-write')
    expect(stored.tasks[0].runs[0].members[0].runtime.permissions?.codex?.sandbox).toBe('read-only')
    expect(first.runtime.permissions?.codex?.sandbox).toBe('read-only')
    await act(async () => emit({ id: 'event-completed', taskId: first.taskId, runId: first.runId, memberId: first.memberId, kind: 'completed', text: '', timestamp: new Date().toISOString(), exitCode: 0 }))
    fireEvent.click(screen.getByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(2))
    const second: StartRequest = bridge.startRun.mock.calls[1][0]
    expect(second.runtime.permissions?.codex).toEqual({ sandbox: 'workspace-write', network: 'deny', additionalDirectories: ['/tmp'] })
    expect(stored.tasks[0].runs[0].members[0].runtime.permissions?.codex?.sandbox).toBe('read-only')
  })
  it('does not launch a process if permissions conflict with extra arguments', async () => {
    stored.settings.runtimes[0].args = ['--yolo']
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await act(async () => {})
    expect(bridge.startRun).not.toHaveBeenCalled()
    expect(stored.tasks[0].runs).toHaveLength(0)
  })
  it('does not launch a process when saving the execution snapshot fails', async () => {
    bridge.saveState.mockImplementation(async (value: AppState) => { if (value.tasks[0].runs.length) throw new Error('disk unavailable'); stored = structuredClone(value) })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(document.body.textContent).toContain('disk unavailable'))
    expect(bridge.startRun).not.toHaveBeenCalled()
    expect(stored.tasks[0].runs).toHaveLength(0)
  })
})


describe('reasoning effort reaches native execution snapshots', () => {
  it.each(['low', 'high', 'max'] as const)('passes Kimi %s to the native request and freezes it in the run', async effort => {
    const kimi = stored.settings.runtimes.find(runtime => runtime.id === 'kimi')!
    kimi.enabled = true
    stored.settings.models = [{ id: 'kimi-k3', name: 'K3', modelId: 'kimi-code/k3', runtimeIds: ['kimi'], providerId: '', enabled: true, supportedReasoningEfforts: ['low', 'high', 'max'] }]
    stored.tasks[0].members[0] = { ...stored.tasks[0].members[0], runtimeId: 'kimi', modelId: 'kimi-code/k3', reasoningEffort: effort }
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    expect(bridge.startRun.mock.calls[0][0]).toMatchObject({ runtime: { adapter: 'kimi' }, model: 'kimi-code/k3', reasoningEffort: effort })
    expect(stored.tasks[0].runs[0].members[0].effectiveReasoningEffort).toBe(effort)
  })
  function withModel() {
    stored.settings.models = [{ id: 'model', name: 'Astra', modelId: 'gpt-6-astra', runtimeIds: ['codex'], enabled: true, providerId: '', reasoningEffort: 'high' }]
    stored.tasks[0].members[0].modelId = 'gpt-6-astra'
  }
  it('resolves the saved model default once per run and retains the old snapshot after settings change', async () => {
    withModel()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    const first: StartRequest = bridge.startRun.mock.calls[0][0]
    expect(first.reasoningEffort).toBe('high')
    expect(stored.tasks[0].runs[0].members[0].effectiveReasoningEffort).toBe('high')
    fireEvent.click(screen.getByRole('button', { name: /^设置$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '保存新的思考强度' }))
    await screen.findByRole('button', { name: '测试执行' })
    expect(stored.settings.models[0].reasoningEffort).toBe('low')
    expect(first.reasoningEffort).toBe('high')
    await act(async () => emit({ id: 'reasoning-complete', taskId: first.taskId, runId: first.runId, memberId: first.memberId, kind: 'completed', text: '', timestamp: new Date().toISOString(), exitCode: 0 }))
    fireEvent.click(screen.getByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(2))
    expect(bridge.startRun.mock.calls[1][0].reasoningEffort).toBe('low')
    expect(stored.tasks[0].runs[0].members[0].effectiveReasoningEffort).toBe('high')
  })
  it('uses a member override ahead of its model default', async () => {
    withModel()
    stored.tasks[0].members[0].reasoningEffort = 'ultra'
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    expect(bridge.startRun.mock.calls[0][0].reasoningEffort).toBe('ultra')
    expect(stored.tasks[0].runs[0].members[0].effectiveReasoningEffort).toBe('ultra')
  })
  it('does not reserve or launch a run with incompatible reasoning effort', async () => {
    withModel()
    stored.settings.models[0].supportedReasoningEfforts = ['low']
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await act(async () => {})
    expect(bridge.startRun).not.toHaveBeenCalled()
    expect(stored.tasks[0].runs).toHaveLength(0)
  })
})


describe('native session continuation dispatch', () => {
  it.each(['codex', 'claude', 'kimi'] as const)('reuses %s session after completion and reload', async adapter => {
    const runtime = stored.settings.runtimes.find(r => r.adapter === adapter)!
    runtime.enabled = true
    stored.tasks[0].members[0].runtimeId = runtime.id
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(1))
    const first: StartRequest = bridge.startRun.mock.calls[0][0]
    expect(first.sessionId).toBeUndefined()
    const frame = adapter === 'codex' ? { type: 'thread.started', thread_id: 'native-session' } : adapter === 'claude' ? { type: 'system', subtype: 'init', session_id: 'native-session' } : { type: 'kimi.session', sessionId: 'native-session' }
    const route = { taskId: first.taskId, runId: first.runId, memberId: first.memberId, timestamp: new Date().toISOString() }
    await act(async () => emit({ ...route, id: 'session', kind: 'stdout', text: JSON.stringify(frame) + '\n' }))
    await act(async () => emit({ ...route, id: 'completed', kind: 'completed', text: '' }))
    await waitFor(() => expect(stored.tasks[0].runs[0].members[0].sessionId).toBe('native-session'))
    cleanup()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /permissions fixture/ }))
    fireEvent.click(await screen.findByRole('button', { name: '测试执行' }))
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledTimes(2))
    const next: StartRequest = bridge.startRun.mock.calls[1][0]
    expect(next.sessionId).toBe('native-session')
    expect(next.runId).not.toBe(first.runId)
    expect(next.prompt).toContain('继续当前 Runtime 原生会话')
    expect(next.prompt).not.toContain('已有公开对话')
    expect(stored.tasks[0].runs[1].members[0].sessionId).toBe('native-session')
  })
})
