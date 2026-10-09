import * as React from 'react'
import { quickFadeWAAPI } from '@/lib/motion'

interface Surface { node?: HTMLElement; animation?: Animation; ghost?: HTMLElement; exit?: Animation }
export interface DialogMotionState {
  open: boolean
  enabled: boolean
  surfaces: Map<string, Surface>
}
export const DialogMotionContext = React.createContext<DialogMotionState | null>(null)
const reduce = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
const opacity = (node: HTMLElement) => Number.parseFloat(getComputedStyle(node).opacity) || 0

/**
 * The interactive Radix surface always closes immediately. A non-interactive
 * visual copy completes its fade, so exit never extends focus or pointer locks.
 * Reopening consumes that copy's presentation opacity instead of restarting.
 */
export function useDialogSurfaceFade(key: 'content' | 'overlay' | 'popover', forwardedRef?: React.Ref<HTMLElement>) {
  const context = React.useContext(DialogMotionContext)
  const latest = React.useRef(context)
  latest.current = context
  const forwarded = React.useRef(forwardedRef)
  forwarded.current = forwardedRef
  const surface = React.useRef<Surface>({})
  const ref = React.useCallback((node: HTMLElement | null) => {
    const state = latest.current
    const value = state?.surfaces.get(key) ?? surface.current
    surface.current = value
    if (state) state.surfaces.set(key, value)
    if (typeof forwarded.current === 'function') forwarded.current(node)
    else if (forwarded.current) forwarded.current.current = node
    if (node) {
      const start = value.ghost ? opacity(value.ghost) : 0
      value.exit?.cancel(); value.ghost?.remove(); value.exit = undefined; value.ghost = undefined
      value.node = node
      if (state?.enabled && !reduce() && node.animate) {
        const animation = node.animate([{ opacity: start }, { opacity: 1 }], quickFadeWAAPI)
        value.animation = animation
        animation.onfinish = () => { if (value.animation === animation) { animation.cancel(); value.animation = undefined } }
      }
      return
    }
    const previous = value.node
    if (!previous) return
    const rect = previous.getBoundingClientRect()
    const start = opacity(previous)
    value.animation?.cancel(); value.animation = undefined; value.node = undefined
    if (state?.open || !state?.enabled || reduce() || !previous.animate || start < 0.001) return
    const ghost = previous.cloneNode(true) as HTMLElement
    // Clones are paint only. Never preserve duplicated IDs, live-region roles,
    // autofocus, interaction or accessibility relationships during the exit.
    ghost.setAttribute('inert', ''); ghost.setAttribute('aria-hidden', 'true')
    ghost.setAttribute('data-dialog-exit', key)
    ghost.style.pointerEvents = 'none'; ghost.style.opacity = String(start)
    for (const element of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const attribute of ['id', 'autofocus', 'aria-labelledby', 'aria-describedby', 'aria-live', 'role']) element.removeAttribute(attribute)
      for (const attribute of [...element.attributes]) if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name)
    }
    if (key === 'popover') {
      // Radix positions popovers via a parent that disappears on close.
      Object.assign(ghost.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', transform: 'none' })
    }
    document.body.append(ghost)
    value.ghost = ghost
    const exit = ghost.animate([{ opacity: start }, { opacity: 0 }], quickFadeWAAPI)
    value.exit = exit
    exit.onfinish = () => { ghost.remove(); if (value.ghost === ghost) { value.ghost = undefined; value.exit = undefined } }
  }, [key])
  return ref
}

export function clearDialogMotion(state: DialogMotionState) {
  for (const surface of state.surfaces.values()) {
    surface.animation?.cancel(); surface.exit?.cancel(); surface.ghost?.remove()
    surface.animation = undefined; surface.exit = undefined; surface.ghost = undefined
  }
}
