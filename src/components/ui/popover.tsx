"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Popover as PopoverPrimitive } from "radix-ui"

// Uses the same interruptible opacity feedback as our dialog surfaces.
import { clearDialogMotion, DialogMotionContext, useDialogSurfaceFade, type DialogMotionState } from './dialog-motion'

function Popover({ open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  const state = React.useRef<DialogMotionState>({ open, enabled: true, surfaces: new Map() })
  state.current.open = open
  React.useEffect(() => {
    const current = state.current
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const settle = () => { if (media?.matches) clearDialogMotion(current) }
    media?.addEventListener('change', settle)
    return () => { media?.removeEventListener('change', settle); clearDialogMotion(current) }
  }, [])
  return <DialogMotionContext.Provider value={state.current}><PopoverPrimitive.Root data-slot="popover" {...props} open={open} onOpenChange={next => {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }} /></DialogMotionContext.Provider>
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const animatedRef = useDialogSurfaceFade('popover', ref)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={animatedRef}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
