"use client"

import { cn } from "@/lib/utils"
import { GripVerticalIcon } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"
import { useEffect, useRef, useState } from "react"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

/** An overlay has no adjacent panel to resize; retain the same separator semantics. */
function OverlayResizeHandle({ label, min, max, getWidth, onResize, onDraggingChange }: {
  label: string; min: number; max: number; getWidth: () => number
  onResize: (width: number) => void; onDraggingChange: (dragging: boolean) => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const [width, setWidth] = useState(getWidth)
  const [active, setActive] = useState(false)
  const resize = (next: number) => {
    const bounded = Math.max(min, Math.min(max, next))
    onResize(bounded); setWidth(bounded)
  }
  function finish() {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (element.current?.hasPointerCapture(current.pointerId)) element.current.releasePointerCapture(current.pointerId)
    setActive(false); onDraggingChange(false)
  }
  useEffect(() => {
    window.addEventListener('blur', finish)
    return () => window.removeEventListener('blur', finish)
  })
  useEffect(() => { finish(); setWidth(getWidth()) }, [min, max])
  return <div ref={element} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical"
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} aria-controls="execution-inspector"
    className="overlay-resize-handle" data-active={active || undefined}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault(); event.currentTarget.focus()
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: getWidth() }
      event.currentTarget.setPointerCapture(event.pointerId)
      setActive(true); onDraggingChange(true)
      resize(getWidth())
    }}
    onPointerMove={event => { const current = drag.current; if (current?.pointerId === event.pointerId) resize(current.width + current.x - event.clientX) }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={event => {
      const step = event.shiftKey ? 50 : 10
      const next = event.key === 'ArrowLeft' ? getWidth() + step : event.key === 'ArrowRight' ? getWidth() - step : event.key === 'Home' ? min : event.key === 'End' ? max : undefined
      if (next === undefined) return
      event.preventDefault(); resize(next)
    }}/>
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup, OverlayResizeHandle }
