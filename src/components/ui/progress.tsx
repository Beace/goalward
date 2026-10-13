import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"
import { motion } from 'motion/react'
import { useAnimatedValue, useAnimatedPresentation } from '@/hooks/use-animated-value'

function Progress({
  className,
  value = 0,
  ref,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(100, value ?? 0)) : 0
  const { value: displayed, ref: appearanceRef } = useAnimatedValue<HTMLDivElement>(normalized)
  const transform = useAnimatedPresentation(displayed, current => `translateX(-${100 - Math.max(0, Math.min(100, current))}%)`)
  React.useImperativeHandle(ref, () => appearanceRef.current!)

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      ref={appearanceRef}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-surface-inset", className)}
      value={normalized}
      {...props}
    >
      <ProgressPrimitive.Indicator asChild>
        <motion.div
        data-slot="progress-indicator"
        className="h-full w-full bg-primary"
        style={{ transform }}
      />
      </ProgressPrimitive.Indicator>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
