import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { animate, useMotionValue, useMotionValueEvent, type AnimationPlaybackControls, type MotionValue } from 'motion/react'
import { numericSpring } from '@/lib/motion'

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
function getReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(reducedMotionQuery).matches)
}

/** First visible appearance starts at zero; subsequent changes keep the live value and velocity. */
export function useAnimatedValue<T extends HTMLElement = HTMLSpanElement>(target: number, { animateUpdates = true }: { animateUpdates?: boolean } = {}) {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => true)
  const canObserve = typeof IntersectionObserver !== 'undefined'
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(!canObserve)
  const appeared = useRef(false)
  const value = useMotionValue(reducedMotion || !canObserve ? target : 0)
  const animation = useRef<AnimationPlaybackControls | null>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !canObserve) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [canObserve])

  useLayoutEffect(() => {
    // Live preference changes also settle hidden values. Turning motion back on
    // never replays an already observed entrance.
    if (!visible && !reducedMotion) {
      // A hidden value may have settled while motion was reduced. Restore its
      // entrance baseline only if it has never actually appeared on screen.
      if (!appeared.current) value.jump(0)
      return
    }
    const firstAppearance = !appeared.current
    if (visible) appeared.current = true
    const velocity = value.getVelocity()
    animation.current?.stop()
    if (reducedMotion || !canObserve || (!firstAppearance && !animateUpdates)) {
      value.jump(target)
    } else {
      animation.current = animate(value, target, { ...numericSpring, velocity })
    }
    return () => animation.current?.stop()
  }, [target, visible, reducedMotion, canObserve, animateUpdates, value])

  return { value, ref, reducedMotion }
}

/** Subscribe before layout jumps so immediate updates never lag by one source value. */
export function useAnimatedPresentation<T>(value: MotionValue<number>, format: (current: number) => T) {
  const presentation = useMotionValue(format(value.get()))
  // Motion's useTransform resubscribes in a layout effect, after the source's
  // layout jump. Its useMotionValueEvent subscribes in an insertion effect,
  // catching both immediate jumps and all subsequent animation frames.
  useMotionValueEvent(value, 'change', current => presentation.set(format(current)))
  useLayoutEffect(() => { presentation.set(format(value.get())) }, [value, format, presentation])
  return presentation
}
