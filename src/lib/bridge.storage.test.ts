// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { createInitialState } from './domain'
import type { AppState } from './types'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }))

beforeEach(() => { vi.resetModules(); native.invoke.mockReset() })

function append(state: AppState, id: string): AppState {
  const task = state.tasks[0]
  return { ...state, tasks: [{ ...task, events: [...task.events, { ...task.events[0], id }] }, ...state.tasks.slice(1)] }
}

it('metadata saves omit loaded history; stream saves send only new events and retain the full in-memory snapshot', async () => {
  const original = createInitialState()
  native.invoke.mockResolvedValueOnce(original).mockResolvedValue(undefined)
  const { loadState, saveState } = await import('./bridge')
  expect(await loadState()).toBe(original)
  const metadata = { ...original, activeTaskId: 'other' }
  await saveState(metadata)
  expect(native.invoke).toHaveBeenLastCalledWith('save_state_delta', {
    state: { ...metadata, tasks: metadata.tasks.map(task => ({ ...task, events: [] })) },
  })
  const streamed = append(metadata, 'new-event')
  await saveState(streamed)
  const payload = native.invoke.mock.calls.at(-1)![1]
  expect(payload.state.tasks[0].events.map((event: { id: string }) => event.id)).toEqual(['new-event'])
  expect(streamed.tasks[0].events).toHaveLength(original.tasks[0].events.length + 1)
  await saveState({ ...streamed })
  expect(native.invoke.mock.calls.at(-1)![1].state.tasks[0].events).toEqual([])
})

it('failed writes do not advance the checkpoint; retries include every uncommitted event', async () => {
  const original = createInitialState()
  native.invoke.mockResolvedValueOnce(original).mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const { loadState, saveState } = await import('./bridge')
  await loadState()
  const first = append(original, 'a'), second = append(first, 'b')
  await expect(saveState(first)).rejects.toThrow('disk full')
  await saveState(second)
  expect(native.invoke.mock.calls.at(-1)![1].state.tasks[0].events.map((event: { id: string }) => event.id)).toEqual(['a', 'b'])
})

it('serializes overlapping writes and computes deltas after the previous transaction commits', async () => {
  const original = createInitialState()
  let release!: () => void
  native.invoke.mockResolvedValueOnce(original).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
  const { loadState, saveState } = await import('./bridge')
  await loadState()
  const first = append(original, 'a'), second = append(first, 'b')
  const writing = saveState(first), pending = saveState(second)
  await Promise.resolve()
  expect(native.invoke).toHaveBeenCalledTimes(2)
  release()
  await Promise.all([writing, pending])
  expect(native.invoke.mock.calls.at(-1)![1].state.tasks[0].events.map((event: { id: string }) => event.id)).toEqual(['b'])
})

it('saves a new workspace completely and can recreate a deleted task with all its history', async () => {
  native.invoke.mockResolvedValueOnce(null).mockResolvedValue(undefined)
  const { loadState, saveState } = await import('./bridge')
  await loadState()
  const original = createInitialState()
  await saveState(original)
  expect(native.invoke.mock.calls.at(-1)![1].state).toEqual(original)
  await saveState({ ...original, tasks: [] })
  await saveState(original)
  expect(native.invoke.mock.calls.at(-1)![1].state).toEqual(original)
})

it('never falls back to the legacy full-snapshot command when the native binary is too old', async () => {
  const original = createInitialState()
  native.invoke.mockResolvedValueOnce(original).mockRejectedValue(new Error('Command save_state_delta not found'))
  const { loadState, saveState } = await import('./bridge')
  await loadState()
  await expect(saveState({ ...original, activeTaskId: 'other' })).rejects.toThrow('not found')
  expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['load_workspace_summary', 'save_state_delta'])
})

it('loads history in bounded pages and never uploads fetched history again', async () => {
  const original = createInitialState()
  const history = original.tasks[0].events
  const summary = { ...original, tasks: original.tasks.map(task => ({ ...task, events: [], historyPending: true })) }
  native.invoke.mockResolvedValueOnce(summary)
    .mockResolvedValueOnce({ events: history.slice(0, 1), next: 0, through: history.length - 1 })
    .mockResolvedValueOnce({ events: history.slice(1), next: null, through: history.length - 1 })
    .mockResolvedValue(undefined)
  const { loadState, loadTaskHistory, saveState } = await import('./bridge')
  await loadState()
  expect(await loadTaskHistory(original.tasks[0].id)).toEqual(history)
  expect(native.invoke.mock.calls[2]).toEqual(['load_task_event_page', { taskId: original.tasks[0].id, after: 0, through: history.length - 1 }])
  await saveState(original)
  expect(native.invoke.mock.calls.at(-1)![1].state.tasks[0].events).toEqual([])
  expect(native.invoke.mock.calls.at(-1)![1].state.tasks[0].historyPending).toBeUndefined()
})
