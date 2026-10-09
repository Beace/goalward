// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, createTask } from '@/lib/domain'
import { RuntimeApprovalPanel } from './RuntimeApprovalPanel'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
function task() {
  const initial = createInitialState()
  const task = createTask(initial.settings, 'Kimi approvals', '/tmp', 'solo')
  const member = task.members[0]
  task.runs = [{ id: 'run', createdAt: '2026-09-17T00:00:00Z', directory: '/tmp', prompt: '', members: [{ ...member, runtime: { ...initial.settings.runtimes[0], adapter: 'kimi' }, model: '', status: 'running' }] }]
  task.events = [{ id: 'event', taskId: task.id, runId: 'run', memberId: member.id, timestamp: '2026-09-17T00:00:01Z', kind: 'stdout', text: JSON.stringify({ type: 'kimi.permission_requested', requestId: 'approval', toolCall: { title: '读取工作目录', rawInput: { path: '/tmp/example' } }, options: [{ optionId: 'once', name: '允许一次', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }] }) + '\n' }]
  return task
}

describe('Runtime approval controls', () => {
  it('submits immediately, reports pending and preserves a retryable error', async () => {
    let fail!: (error: Error) => void
    invoke.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    const current = task()
    render(<RuntimeApprovalPanel task={current} />)
    const allow = screen.getByRole('button', { name: '允许一次' }) as HTMLButtonElement
    fireEvent.click(allow)
    expect(invoke).toHaveBeenCalledWith('respond_runtime_permission', { runId: 'run', memberId: current.members[0].id, requestId: 'approval', optionId: 'once' })
    expect(allow.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在提交…')
    fail(new Error('connection failed'))
    await waitFor(() => expect(allow.disabled).toBe(false))
    expect(screen.getByText('connection failed')).toBeTruthy()
    invoke.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('respond_runtime_permission', expect.objectContaining({ optionId: 'reject' })))
  })
  it('never offers stale approvals for completed runs', () => {
    const current = task()
    current.runs[0].members[0].status = 'interrupted'
    render(<RuntimeApprovalPanel task={current} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
