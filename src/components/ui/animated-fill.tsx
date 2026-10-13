import type { ComponentProps } from 'react'
import { motion } from 'motion/react'
import { useAnimatedValue, useAnimatedPresentation } from '@/hooks/use-animated-value'
import { cn } from '@/lib/utils'

/** A decorative fill inside a stable chart cell; the cell's hit area never shrinks. */
function AnimatedFill({ value: target, className, ...props }: Omit<ComponentProps<typeof motion.span>, 'style' | 'children' | 'ref'> & { value: number }) {
  const normalized = Number.isFinite(target) ? Math.max(0, Math.min(100, target)) : 0
  const { value, ref } = useAnimatedValue(normalized)
  const transform = useAnimatedPresentation(value, current => `scaleX(${Math.max(0, Math.min(100, current)) / 100})`)
  // Observe the untransformed container: a zero-width scaled fill cannot reveal
  // itself if its own transformed box is the intersection target.
  return <span ref={ref} aria-hidden="true" className="animated-fill-container">
    <motion.span {...props} data-slot="animated-fill" data-fill-target={normalized}
      className={cn('animated-fill', className)} style={{ transform, transformOrigin: 'left center' }} />
  </span>
}

export { AnimatedFill }
