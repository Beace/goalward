import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type AnimationPlaybackControls } from 'motion/react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { OverlayResizeHandle, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { inspectorSizing, quietSpring } from '@/lib/motion'

type Props = { open: boolean; compact: boolean; onOpenChange: (open: boolean) => void; children: ReactNode; inspector: ReactNode }

/** Keep one trace tree alive; animate its reserved space and its right-edge transform together. */
export function InspectorLayout({ open, compact: forcedCompact, onOpenChange, children, inspector }: Props) {
  const reduced = useReducedMotion()
  const panel = useRef<PanelImperativeHandle | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const pointer = useRef<PointerEvent | null>(null)
  const remembered = useRef<number>(inspectorSizing.default)
  const shown = useMotionValue<number>(open ? inspectorSizing.default : 0)
  const contentWidth = useMotionValue<number>(inspectorSizing.default)
  const x = useTransform(() => contentWidth.get() - shown.get())
  const animation = useRef<AnimationPlaybackControls | null>(null)
  const moving = useRef(false)
  const dragging = useRef(false)
  const interrupted = useRef(false)
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth)
  const compact = forcedCompact || layoutWidth < 760
  const maxWidth = Math.max(inspectorSizing.min, layoutWidth - (compact ? 8 : inspectorSizing.conversationMin + 1))
  const boundWidth = (width: number) => Math.max(inspectorSizing.min, Math.min(maxWidth, width))
  const lastLayoutWidth = useRef(layoutWidth)
  const [previous, setPrevious] = useState({ open, compact })

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => { if (element.clientWidth > 0) setLayoutWidth(element.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const generation = useRef(0)
  const [phase, setPhase] = useState<'idle' | 'animating' | 'dragging'>('idle')
  const [settle, setSettle] = useState(0)
  // Drop the minimum before the first animation frame; v4 otherwise snaps 0..280px.
  const changing = previous.open !== open || previous.compact !== compact
  const constrained = open && !compact && !changing && phase === 'idle'

  function restoreFocus() {
    root.current?.querySelector<HTMLButtonElement>('[data-inspector-toggle]')?.focus({ preventScroll: true })
  }

  function releaseNativeResize() {
    // react-resizable-panels v4 listens for pointerup, but not pointercancel.
    // Release its active gesture as well when we cancel or change layout modes.
    const last = pointer.current
    if (last) document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: last.pointerId, pointerType: last.pointerType,
      clientX: last.clientX, clientY: last.clientY, button: 0,
    }))
    pointer.current = null
  }

  useLayoutEffect(() => {
    handle.current?.setAttribute('tabindex', open && !compact ? '0' : '-1')
    const wasOpen = previous.open
    // Commit the applied layout even when an interrupted drag already reached
    // the target. A ref + idle -> idle update leaves `changing`/minSize stale.
    setPrevious({ open, compact })
    if (!open && wasOpen && (surface.current?.contains(document.activeElement) || document.activeElement === document.body
      || document.activeElement?.id === 'inspector-resize')) restoreFocus()
    if (dragging.current) {
      dragging.current = false
      interrupted.current = false
      releaseNativeResize()
    }
    const run = ++generation.current
    const widthChanged = lastLayoutWidth.current !== layoutWidth
    lastLayoutWidth.current = layoutWidth
    const target = open ? boundWidth(remembered.current) : 0
    contentWidth.set(boundWidth(remembered.current))
    moving.current = true
    setPhase('animating')
    if (compact) panel.current?.resize(0)
    const resize = (value: number) => { if (!compact) panel.current?.resize(Math.max(0, value)) }
    const complete = () => {
      if (run !== generation.current) return
      if (!open && (surface.current?.contains(document.activeElement) || document.activeElement === handle.current)) restoreFocus()
      moving.current = false
      setPhase('idle')
    }
    if (reduced || widthChanged || Math.abs(shown.get() - target) < 0.1) {
      shown.jump(target)
      resize(target)
      complete()
    } else {
      // Retarget the live value and velocity. No timer, remount, or input lock.
      animation.current = animate(shown, target, {
        ...quietSpring, velocity: shown.getVelocity(),
        onUpdate: resize, onComplete: complete,
      })
    }
    return () => { generation.current++; animation.current?.stop() }
  }, [open, compact, reduced, settle, shown, contentWidth, layoutWidth, maxWidth])

  function beginResize() {
    if (compact || dragging.current) return
    dragging.current = true
    if (!moving.current) return
    interrupted.current = true
    generation.current++
    animation.current?.stop()
    moving.current = false
    shown.jump(panel.current?.getSize().inPixels ?? shown.get())
    // Keep minSize=0 while grabbing a partially open panel; restoring 280 here jumps.
    setPhase('dragging')
  }

  function finishResize() {
    if (!dragging.current) return
    dragging.current = false
    const size = panel.current?.getSize().inPixels ?? shown.get()
    if (interrupted.current && size < inspectorSizing.min) {
      // Only an interrupted opening/closing can land below the normal minimum.
      // Settle that unfinished transition without adding inertia to ordinary resizing.
      const expand = size >= inspectorSizing.min / 2
      remembered.current = Math.max(inspectorSizing.min, remembered.current)
      interrupted.current = false
      if (!expand) restoreFocus()
      onOpenChange(expand)
      setSettle(value => value + 1)
      return
    }
    interrupted.current = false
    remembered.current = boundWidth(size)
    contentWidth.jump(remembered.current)
    shown.jump(remembered.current)
    setPhase('idle')
    if (!open) onOpenChange(true)
  }

  useLayoutEffect(() => {
    const finish = () => finishResize()
    const cancel = () => { if (dragging.current) { releaseNativeResize(); finishResize() } }
    const track = (event: PointerEvent) => { if (event.button === 0) pointer.current = event }
    // The primitive's hit area extends beyond its 1px DOM line. Observe its
    // actual active state so clicks in that enlarged area also stop the spring.
    const observer = new MutationObserver(() => {
      if (handle.current?.dataset.separator === 'active') beginResize()
    })
    if (handle.current) observer.observe(handle.current, { attributes: true, attributeFilter: ['data-separator'] })
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      observer.disconnect()
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
    }
  })

  return <div ref={root} className="main-panes inspector-layout" data-inspector-motion={changing ? 'animating' : phase}>
    <ResizablePanelGroup orientation="horizontal" id="workbench-panes" onLayoutChanged={(_, meta) => {
      if (meta.isUserInteraction && !moving.current && !dragging.current && open && !compact) {
        remembered.current = boundWidth(panel.current?.getSize().inPixels ?? remembered.current)
      }
    }}>
      <ResizablePanel id="conversation" minSize={`${inspectorSizing.conversationMin}px`}>{children}</ResizablePanel>
      <ResizableHandle id="inspector-resize" elementRef={handle} aria-label="调整执行检查器宽度" aria-hidden={!open || compact}
        disabled={compact || (!open && phase === 'idle')}
        className="inspector-resize" style={{ visibility: compact || (!open && phase === 'idle') ? 'hidden' : 'visible' }}
        onPointerDownCapture={event => { if (event.button === 0 && event.isPrimary) beginResize() }}
        onKeyDownCapture={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) beginResize() }}
        onKeyUpCapture={finishResize} />
      <ResizablePanel id="inspector-space" panelRef={panel} aria-hidden="true"
        defaultSize={open && !compact ? inspectorSizing.default : 0}
        minSize={constrained ? inspectorSizing.min : 0} maxSize={compact ? 0 : maxWidth}
        groupResizeBehavior="preserve-pixel-size"
        onResize={size => {
          if (!compact && !moving.current && (open || dragging.current)) {
            contentWidth.jump(size.inPixels)
            shown.jump(size.inPixels)
          }
        }}><div /></ResizablePanel>
    </ResizablePanelGroup>
    <motion.div ref={surface} id="execution-inspector" className={`inspector-surface${compact ? ' inspector-floating' : ''}`}
      style={{ width: contentWidth, x, visibility: !open && phase === 'idle' && !changing ? 'hidden' : 'visible' }}
      aria-hidden={!open} inert={!open}
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); restoreFocus(); onOpenChange(false) } }}>
      {compact && open && <OverlayResizeHandle label="调整产物与执行面板宽度" min={inspectorSizing.min} max={maxWidth} getWidth={() => contentWidth.get()}
        onResize={width => {
          generation.current++; animation.current?.stop(); moving.current = false
          remembered.current = boundWidth(width)
          contentWidth.jump(remembered.current); shown.jump(remembered.current)
        }} onDraggingChange={active => setPhase(active ? 'dragging' : 'idle')} />}
      {inspector}
    </motion.div>
  </div>
}
