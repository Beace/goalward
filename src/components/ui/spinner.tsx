import type { ComponentProps } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

// shadcn/ui Spinner, using the project's icon and reduced-motion conventions.
function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return <LoaderCircle
    data-slot="spinner"
    role="status"
    aria-label="加载中"
    className={cn('size-4 shrink-0 animate-spin motion-reduce:animate-none', className)}
    {...props}
  />
}

export { Spinner }
