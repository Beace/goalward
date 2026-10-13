import { useMemo, type ComponentProps } from 'react'
import { motion } from 'motion/react'
import { useAnimatedValue, useAnimatedPresentation } from '@/hooks/use-animated-value'
import { cn } from '@/lib/utils'

function decimalPlaces(value: number) {
  const [coefficient, exponent = '0'] = String(value).split('e')
  return Math.min(20, Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)))
}

type AnimatedNumberProps = Omit<ComponentProps<'span'>, 'children'> & {
  value: number
  format?: (value: number) => string
  /** Clocks and streaming counters enter once, then follow their source immediately. */
  animateUpdates?: boolean
}

/** Reserves the final number's width and exposes only the true target to assistive technology. */
function AnimatedNumber({ value: target, format, animateUpdates, className, ...props }: AnimatedNumberProps) {
  const safeTarget = Number.isFinite(target) ? target : 0
  const defaultFormat = useMemo(() => {
    const precision = decimalPlaces(safeTarget)
    return (current: number) => String(Number(current.toFixed(precision)))
  }, [safeTarget])
  const formatter = format ?? defaultFormat
  const { value, ref } = useAnimatedValue(safeTarget, { animateUpdates })
  const text = useAnimatedPresentation(value, formatter)
  // Retain the observed DOM node when data changes from unknown to a number.
  if (!Number.isFinite(target)) return <span ref={ref} className={className} {...props}>—</span>
  return <span {...props} ref={ref} className={cn('animated-number', className)} data-slot="animated-number" data-number-target={target}>
    <span className="animated-number-target">{formatter(target)}</span>
    <motion.span aria-hidden="true" data-slot="animated-number-value">{text}</motion.span>
  </span>
}

/** Numeric configuration values may also be strings; prose, IDs and unknown values stay literal. */
function AnimatedNumberText({ value, format, animateUpdates, ...props }: Omit<AnimatedNumberProps, 'value'> & { value: string | number }) {
  if (typeof value === 'number') return <AnimatedNumber value={value} format={format} animateUpdates={animateUpdates} {...props} />
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || /^[-+]?0\d/.test(value) || !Number.isFinite(Number(value))) {
    return <span {...props}>{value}</span>
  }
  const precision = value.split('.')[1]?.length ?? 0
  return <AnimatedNumber value={Number(value)} format={format ?? (current => `${value.startsWith('+') ? '+' : ''}${current.toFixed(Math.min(20, precision))}`)} animateUpdates={animateUpdates} {...props} />
}

export { AnimatedNumber, AnimatedNumberText }
