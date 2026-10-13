// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notify, Toaster } from './sonner'
beforeEach(() => { Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' }); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('notification actions', () => {
  it('preserves its action through keyboard focus updates and activates it once', async () => {
    const action = vi.fn()
    render(<><button>Workbench</button><Toaster /></>)
    act(() => { notify.info('New version available', { action: { label: 'View update', onClick: action } }) })
    const button = await screen.findByRole('button', { name: 'View update' })
    act(() => { screen.getByRole('button', { name: 'Workbench' }).focus(); button.focus() })
    expect(screen.getByRole('button', { name: 'View update' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View update' }))
    expect(action).toHaveBeenCalledOnce()
  })
})
