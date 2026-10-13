// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@/lib/domain'
import { createGoal } from '@/lib/goals'
import { createWorkspaceTask } from '@/lib/workspace'
import type { AppState } from '@/lib/types'
import { GoalWorkspaceDirectories } from './GoalWorkspaceDirectories'

afterEach(cleanup)
function mount(failOnce = false, duringFailedWrite?: (state: AppState) => AppState) {
  const seed = createInitialState()
  const goal = { ...createGoal({ title: 'Project goal' }), workingDirectories: ['/project/main', '/project/data'] }
  const task = createWorkspaceTask(seed.settings, { title: 'Project task', goalId: goal.id, workingDirectories: goal.workingDirectories })
  const history = { id: 'old-run', createdAt: task.createdAt, directory: '/project/main', workingDirectories: ['/project/main', '/historic/data'], prompt: 'Historical input', members: [] }
  task.runs = [history]
  const committed = vi.fn()
  const projected = vi.fn()
  function Harness() {
    const current = useRef<AppState>({ ...seed, goals: [goal], tasks: [task] })
    const [state, setState] = useState(current.current)
    return <GoalWorkspaceDirectories state={state} goal={state.goals[0]} onChange={async reducer => {
      // Match useAppState: the renderer and latest-state ref project the reducer
      // before persistence resolves. Failure must undo the already applied edit.
      const next = reducer(current.current); current.current = next; projected(next); setState(next)
      if (failOnce) {
        failOnce = false
        if (duringFailedWrite) { current.current = duringFailedWrite(next); projected(current.current); setState(current.current) }
        throw new Error('workspace disk unavailable')
      }
      committed(next)
    }} />
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '管理目标工作目录' }))
  return { committed, projected, history }
}

describe('fixed goal workspace controls', () => {
  it('sets the primary root, retains the other roots and historical run, and prevents removing the last root', async () => {
    const { committed, history } = mount()
    fireEvent.click(screen.getByRole('button', { name: '设为主目录: /project/data' }))
    await screen.findByRole('status')
    const saved: AppState = committed.mock.calls.at(-1)![0]
    expect(saved.goals[0].workingDirectories).toEqual(['/project/data', '/project/main'])
    expect(saved.tasks[0].directory).toBe('/project/data')
    expect(saved.tasks[0].runs[0]).toBe(history)
    fireEvent.click(screen.getByRole('button', { name: '移除目录引用: /project/main' }))
    await waitFor(() => expect(committed.mock.calls.at(-1)![0].goals[0].workingDirectories).toEqual(['/project/data']))
    expect((screen.getByRole('button', { name: '移除目录引用: /project/data' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('adds a path using Enter, deduplicates existing paths, and reports invalid relative paths', async () => {
    const { committed } = mount()
    const input = screen.getByRole('textbox', { name: '添加目标工作目录路径' })
    fireEvent.change(input, { target: { value: '/new/data' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(committed.mock.calls.at(-1)![0].goals[0].workingDirectories).toEqual(['/project/main', '/project/data', '/new/data']))
    expect((input as HTMLInputElement).value).toBe('')
    fireEvent.change(input, { target: { value: '/new/data/' } })
    fireEvent.click(screen.getByRole('button', { name: '添加工作目录' }))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))
    expect(committed.mock.calls.at(-1)![0].goals[0].workingDirectories).toHaveLength(3)
    fireEvent.change(input, { target: { value: 'relative/path' } })
    fireEvent.click(screen.getByRole('button', { name: '添加工作目录' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('绝对目录'))
    expect((input as HTMLInputElement).value).toBe('relative/path')
  })

  it('preserves the path and workspace when saving fails and accepts a retry', async () => {
    const { committed, projected } = mount(true)
    const input = screen.getByRole('textbox', { name: '添加目标工作目录路径' })
    fireEvent.change(input, { target: { value: '/retry/data' } })
    fireEvent.click(screen.getByRole('button', { name: '添加工作目录' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('workspace disk unavailable'))
    expect(projected.mock.calls[0][0].tasks[0].workingDirectories).toEqual(['/project/main', '/project/data', '/retry/data'])
    expect(committed.mock.calls.at(-1)![0].goals[0].workingDirectories).toEqual(['/project/main', '/project/data'])
    expect(committed.mock.calls.at(-1)![0].tasks[0].workingDirectories).toEqual(['/project/main', '/project/data'])
    expect((input as HTMLInputElement).value).toBe('/retry/data')
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加工作目录' }))
    await screen.findByRole('status')
    expect(committed.mock.calls.at(-1)![0].goals[0].workingDirectories).toEqual(['/project/main', '/project/data', '/retry/data'])
  })

  it('rolls back an already projected primary directory change without discarding concurrent native history', async () => {
    const messages = [{ id: 'concurrent-reply', role: 'assistant' as const, text: 'Content received during saving', createdAt: new Date().toISOString() }]
    const { committed, projected, history } = mount(true, current => ({ ...current, tasks: current.tasks.map(task => ({ ...task, messages, historyPending: true })) }))
    fireEvent.click(screen.getByRole('button', { name: '设为主目录: /project/data' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('workspace disk unavailable'))
    expect(projected.mock.calls[0][0].tasks[0]).toMatchObject({ directory: '/project/data', workingDirectories: ['/project/data', '/project/main'], legacyArtifactDirectory: '/project/main' })
    const restored: AppState = committed.mock.calls.at(-1)![0]
    expect(restored.goals[0].workingDirectories).toEqual(['/project/main', '/project/data'])
    expect(restored.tasks[0]).toMatchObject({ directory: '/project/main', workingDirectories: ['/project/main', '/project/data'], historyPending: true })
    expect(Object.hasOwn(restored.tasks[0], 'legacyArtifactDirectory')).toBe(false)
    expect(restored.tasks[0].messages).toBe(messages)
    expect(restored.tasks[0].runs[0]).toBe(history)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设为主目录: /project/data' }))
    await screen.findByRole('status')
    expect(committed.mock.calls.at(-1)![0].tasks[0].directory).toBe('/project/data')
    expect(committed.mock.calls.at(-1)![0].tasks[0].messages).toBe(messages)
  })
})
