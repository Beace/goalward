import type { ComponentProps } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

// shadcn/ui Spinner, using the project's icon and reduced-motion conventions.
function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  const { t } = useI18n()
  return <LoaderCircle
    data-slot="spinner"
    role="status"
    aria-label={t('加载中', 'Loading')}
    className={cn('size-4 shrink-0 animate-spin motion-reduce:animate-none', className)}
    {...props}
  />
}

export { Spinner }
