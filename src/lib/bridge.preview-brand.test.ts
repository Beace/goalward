// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { createInitialState } from './domain'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

it('copies an existing preview workspace to the Goalward key without deleting the old key', async () => {
  const state = createInitialState()
  const json = JSON.stringify(state)
  localStorage.setItem('super-agents.preview.v1', json)
  localStorage.setItem('super-agents.preview.v1.backup', 'previous backup')
  const { loadState, storageInfo } = await import('./bridge')

  expect(await loadState()).toEqual(state)
  expect(localStorage.getItem('goalward.preview.v1')).toBe(json)
  expect(localStorage.getItem('goalward.preview.v1.backup')).toBe('previous backup')
  expect(localStorage.getItem('super-agents.preview.v1')).toBe(json)
  expect((await storageInfo()).bytes).toBe(new Blob([json]).size)
})

it('keeps an existing Goalward workspace authoritative and leaves the old one untouched', async () => {
  const current = { ...createInitialState(), activeTaskId: 'current' }
  const legacy = { ...createInitialState(), activeTaskId: 'legacy' }
  localStorage.setItem('goalward.preview.v1', JSON.stringify(current))
  localStorage.setItem('super-agents.preview.v1', JSON.stringify(legacy))
  const { loadState, saveState } = await import('./bridge')

  expect(await loadState()).toEqual(current)
  await saveState({ ...current, activeTaskId: 'updated' })
  expect(JSON.parse(localStorage.getItem('goalward.preview.v1')!).activeTaskId).toBe('updated')
  expect(JSON.parse(localStorage.getItem('super-agents.preview.v1')!).activeTaskId).toBe('legacy')
})
