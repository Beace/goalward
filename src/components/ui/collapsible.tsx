import { createContext, useContext, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type RefObject } from 'react'
import { animate, motion, useMotionValue, type AnimationPlaybackControls } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import { quietSpring } from '@/lib/motion'

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
function getReducedMotion() { return typeof window !== 'undefined' && Boolean(window.matchMedia?.(reducedMotionQuery).matches) }
const CollapsibleContext = createContext<{ open: boolean; reduced: boolean; trigger: RefObject<HTMLButtonElement | null> } | null>(null)
function useCollapsible() {
  const context = useContext(CollapsibleContext)
  if (!context) throw new Error('Collapsible components must be inside Collapsible')
  return context
}

function Collapsible({ open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  // Motion's installed useReducedMotion takes an initial snapshot; subscribe here
  // so changing the system preference also settles an in-flight disclosure.
  const reduced = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <CollapsibleContext.Provider value={{ open, reduced, trigger }}>
    <CollapsiblePrimitive.Root data-slot="collapsible" {...props} open={open} onOpenChange={next => {
      if (controlledOpen === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    }} />
  </CollapsibleContext.Provider>
}

function CollapsibleTrigger({ ref, ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  const { trigger } = useCollapsible()
  useImperativeHandle(ref, () => trigger.current!)
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} ref={trigger} />
}

function CollapsibleContent({ children, ref, style, forceMount, unmountOnExit = false, ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent> & { unmountOnExit?: boolean }) {
  const { open, reduced, trigger } = useCollapsible()
  const surface = useRef<HTMLDivElement>(null)
  const measurement = useRef<HTMLDivElement>(null)
  const [visited, setVisited] = useState(open)
  const [phase, setPhase] = useState<'idle' | 'animating'>('idle')
  const initialized = useRef(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  const moving = useRef(false)
  const generation = useRef(0)
  const targetHeight = useRef(0)
  const height = useMotionValue(0)
  const opacity = useMotionValue(open ? 1 : 0)
  const animations = useRef<AnimationPlaybackControls[]>([])
  const changing = previousOpen !== open
  // Read-only details release their subtree after exit; editable disclosures retain drafts.
  const hasContent = open || Boolean(forceMount) || (visited && (!unmountOnExit || changing || phase === 'animating'))
  useImperativeHandle(ref, () => surface.current!)

  useLayoutEffect(() => {
    const firstRender = !initialized.current
    initialized.current = true
    const toggled = previousOpen !== open
    // Commit even a static update. A ref alone leaves the rendered `changing`
    // marker/visibility stale when reduced motion keeps phase at idle.
    setPreviousOpen(open)
    if (open) setVisited(true)
    if (!open && surface.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })

    const measure = () => measurement.current?.getBoundingClientRect().height ?? 0
    const settle = () => {
      moving.current = false
      setPhase('idle')
    }
    const moveHeight = (target: number) => {
      const currentGeneration = ++generation.current
      targetHeight.current = target
      const complete = () => { if (currentGeneration === generation.current) settle() }
      // Retarget the same value with its current velocity; never jump to a stale
      // logical endpoint when the user reverses an unfinished transition.
      animations.current[0]?.stop()
      animations.current[0] = animate(height, target, {
        ...quietSpring, velocity: height.getVelocity(), onComplete: complete,
      })
    }

    const measuredHeight = measure()
    const target = open ? measuredHeight : 0
    if (firstRender || reduced || (!toggled && !moving.current) || Math.abs(height.get() - target) < 0.1) {
      height.jump(target)
      opacity.jump(open ? 1 : 0)
      targetHeight.current = target
      settle()
    } else {
      // An idle open disclosure uses auto height. Read its live size before
      // closing; dynamic output and nested disclosures have already laid out.
      if (!moving.current && !open) height.jump(measuredHeight)
      moving.current = true
      setPhase('animating')
      moveHeight(target)
      animations.current[1] = animate(opacity, open ? 1 : 0, {
        ...quietSpring, velocity: opacity.getVelocity(),
      })
    }

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (!open) return
      const next = measure()
      if (!moving.current) {
        // Once open, natural layout owns height. Streaming updates and nested
        // disclosure motion must not keep restarting an ancestor spring.
        height.jump(next)
        targetHeight.current = next
      } else if (Math.abs(next - targetHeight.current) > 0.5) moveHeight(next)
    })
    if (measurement.current) observer?.observe(measurement.current)
    return () => {
      generation.current++
      animations.current.forEach(animation => animation.stop())
      observer?.disconnect()
    }
  }, [open, reduced, hasContent, height, opacity, trigger])

  const animating = changing || phase === 'animating'
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} ref={surface} forceMount
    data-collapsible-motion={animating ? 'animating' : 'idle'}
    hidden={!open && !animating}
    aria-hidden={!open || props['aria-hidden']}
    inert={!open || props.inert}
    // Radix's CSS animation hooks must not compete with the shared spring.
    style={{ ...style, animation: 'none', transition: 'none' }}>
    <motion.div style={{ height: animating ? height : open ? 'auto' : 0, opacity, overflow: animating || !open ? 'hidden' : undefined }}>
      <div ref={measurement} data-slot="collapsible-measure" style={{ display: 'flow-root' }}>{hasContent ? children : null}</div>
    </motion.div>
  </CollapsiblePrimitive.CollapsibleContent>
}

const MotionChevronRight = motion.create(ChevronRight)
function CollapsibleIndicator({ style, ...props }: Omit<ComponentProps<typeof MotionChevronRight>, 'animate' | 'initial' | 'transition'>) {
  const { open, reduced } = useCollapsible()
  const rotation = useMotionValue(open ? 90 : 0)
  useLayoutEffect(() => {
    const target = open ? 90 : 0
    if (reduced) { rotation.jump(target); return }
    const animation = animate(rotation, target, { ...quietSpring, velocity: rotation.getVelocity() })
    return () => animation.stop()
  }, [open, reduced, rotation])
  return <MotionChevronRight aria-hidden="true" data-slot="collapsible-indicator" {...props} style={{ ...style, rotate: rotation }} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent, CollapsibleIndicator }
