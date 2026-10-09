import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

// Static placeholders keep frequent page loading quiet, including reduced motion.
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('rounded-md bg-muted', className)} {...props} />
}
