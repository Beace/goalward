// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { captureDialogPresentation, clearDialogMotion, DialogMotionContext, useDialogSurfaceFade, type DialogMotionState } from './dialog-motion'

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).animate
})

it('retains live opacity, position and content when a Select surface detaches before its exit ref', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const animations: Animation[] = []
  const animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation
    animations.push(animation)
    return animation
  })
  vi.stubGlobal('getComputedStyle', (node: HTMLElement) => ({ opacity: node.isConnected ? '0.6' : '' }))
  const state: DialogMotionState = { open: true, enabled: true, surfaces: new Map() }
  const { result } = renderHook(() => useDialogSurfaceFade('popover'), { wrapper: ({ children }) => <DialogMotionContext.Provider value={state}>{children}</DialogMotionContext.Provider> })
  const node = document.createElement('div')
  node.innerHTML = '<span id="original-option" role="option">浅色</span>'
  node.animate = animate
  node.getBoundingClientRect = () => ({ left: 100, top: 200, width: 320, height: 110 }) as DOMRect
  document.body.append(node)
  let detach: void | (() => void) = undefined
  act(() => { detach = result.current(node) })
  captureDialogPresentation(state)
  node.remove()
  state.open = false
  // cloneNode doesn't copy the instance animate property, just like native DOM.
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  expect(typeof detach).toBe('function')
  act(() => { detach?.() })
  const ghost = document.querySelector<HTMLElement>('[data-dialog-exit=popover]')!
  expect(ghost.textContent).toBe('浅色')
  expect(ghost.style.opacity).toBe('0.6')
  expect(ghost.style.left).toBe('100px')
  expect(ghost.style.width).toBe('320px')
  expect(ghost.hasAttribute('inert')).toBe(true)
  expect(ghost.getAttribute('aria-hidden')).toBe('true')
  expect(ghost.querySelector('[id], [role]')).toBeNull()
  expect(animate.mock.calls).toHaveLength(2)
  clearDialogMotion(state)
  expect(document.querySelector('[data-dialog-exit]')).toBeNull()
})

it('runs the attached forwarded-ref cleanup once even when the forwarded ref changes before detach', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const forwardedCleanup = vi.fn()
  const originalRef = vi.fn(() => forwardedCleanup)
  const replacementRef = vi.fn()
  const state: DialogMotionState = { open: true, enabled: false, surfaces: new Map() }
  const { result, rerender } = renderHook(({ forwarded }) => useDialogSurfaceFade('popover', forwarded), {
    initialProps: { forwarded: originalRef },
    wrapper: ({ children }) => <DialogMotionContext.Provider value={state}>{children}</DialogMotionContext.Provider>,
  })
  const node = document.createElement('div')
  let detach: void | (() => void) = undefined
  act(() => { detach = result.current(node) })
  rerender({ forwarded: replacementRef })
  act(() => { detach?.(); detach?.(); result.current(null) })
  expect(originalRef).toHaveBeenCalledExactlyOnceWith(node)
  expect(forwardedCleanup).toHaveBeenCalledTimes(1)
  expect(replacementRef).not.toHaveBeenCalled()
  expect(state.surfaces.get('popover')?.node).toBeUndefined()
})

it('does not create a closing copy during StrictMode attach cleanup while the menu is open', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('getComputedStyle', () => ({ opacity: '0.6' }))
  const state: DialogMotionState = { open: true, enabled: true, surfaces: new Map() }
  const forwarded = { current: null as HTMLElement | null }
  const { result } = renderHook(() => useDialogSurfaceFade('popover', forwarded), {
    wrapper: ({ children }) => <DialogMotionContext.Provider value={state}>{children}</DialogMotionContext.Provider>,
  })
  const node = document.createElement('div')
  const cancel = vi.fn()
  node.animate = vi.fn(() => ({ cancel }) as unknown as Animation)
  document.body.append(node)
  act(() => { result.current(node)?.() })
  expect(forwarded.current).toBeNull()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-dialog-exit]')).toBeNull()
  act(() => { result.current(node) })
  expect(forwarded.current).toBe(node)
  expect(node.animate).toHaveBeenCalledTimes(2)
  expect(node.animate).toHaveBeenLastCalledWith([{ opacity: 0.6 }, { opacity: 1 }], expect.any(Object))
  node.remove()
  clearDialogMotion(state)
})
