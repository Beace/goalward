// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notify, Toaster } from './sonner'
beforeEach(() => { Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' }); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('notification actions', () => {
  it('preserves its action through keyboard focus updates and activates it once', async () => {
    const action = vi.fn()
    render(<><button>工作台</button><Toaster /></>)
    act(() => { notify.info('有新版本', { action: { label: '查看更新', onClick: action } }) })
    const button = await screen.findByRole('button', { name: '查看更新' })
    act(() => { screen.getByRole('button', { name: '工作台' }).focus(); button.focus() })
    expect(screen.getByRole('button', { name: '查看更新' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看更新' }))
    expect(action).toHaveBeenCalledOnce()
  })
})
