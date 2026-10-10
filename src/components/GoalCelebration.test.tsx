// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoalCelebration } from './GoalCelebration'

const motionPreference = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ motion: { div: 'div', i: 'i' }, useReducedMotion: () => motionPreference.reduced }))
afterEach(() => { cleanup(); vi.useRealTimers(); motionPreference.reduced = false })
describe('Goal confirmation feedback', () => {
  it('announces confirmation without moving keyboard focus and permits immediate dismissal', () => {
    const dismiss = vi.fn()
    render(<><button>确认来源</button><GoalCelebration onDismiss={dismiss} /></>)
    screen.getByRole('button', { name: '确认来源' }).focus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认来源' }))
    expect(screen.getByRole('status').textContent).toContain('目标已明确')
    expect(document.querySelectorAll('.goal-celebration-particles i')).toHaveLength(16)
    fireEvent.click(screen.getByRole('button', { name: '关闭目标确认提示' }))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
  it('retains meaningful feedback with no particles under reduced motion', () => {
    motionPreference.reduced = true
    render(<GoalCelebration onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(document.querySelector('.goal-celebration-particles')).toBeNull()
  })
  it('cleans up its dismissal timer when unmounted', () => {
    vi.useFakeTimers()
    const dismiss = vi.fn()
    const view = render(<GoalCelebration onDismiss={dismiss} />)
    view.unmount()
    vi.advanceTimersByTime(5000)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('keeps its original lifetime across streamed rerenders while calling the latest dismiss callback', () => {
    vi.useFakeTimers()
    const first = vi.fn(), latest = vi.fn()
    const view = render(<GoalCelebration onDismiss={first} />)
    vi.advanceTimersByTime(2000)
    view.rerender(<GoalCelebration onDismiss={latest} />)
    vi.advanceTimersByTime(3000)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })
})
