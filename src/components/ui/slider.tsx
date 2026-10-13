import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

// shadcn/ui Radix Slider, adapted to the shared theme and compact hit targets.
// Source: https://ui.shadcn.com/r/styles/new-york-v4/slider.json
function Slider({ className, defaultValue, value, min = 0, max = 100, thumbProps, ...props }: React.ComponentProps<typeof SliderPrimitive.Root> & {
  thumbProps?: React.ComponentProps<typeof SliderPrimitive.Thumb>
}) {
  const values = React.useMemo(() => Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max], [value, defaultValue, min, max])
  const { className: thumbClassName, ...thumbAttributes } = thumbProps ?? {}

  return <SliderPrimitive.Root
    data-slot="slider"
    defaultValue={defaultValue}
    value={value}
    min={min}
    max={max}
    className={cn('relative flex min-h-7 w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-7 data-[orientation=vertical]:flex-col', className)}
    {...props}
  >
    <SliderPrimitive.Track data-slot="slider-track" className="relative grow overflow-hidden rounded-full bg-secondary data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5">
      <SliderPrimitive.Range data-slot="slider-range" className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
    </SliderPrimitive.Track>
    {Array.from({ length: values.length }, (_, index) => <SliderPrimitive.Thumb
      key={index}
      data-slot="slider-thumb"
      aria-disabled={props.disabled}
      className={cn('flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none active:ring-[3px] active:ring-ring/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50', thumbClassName)}
      {...thumbAttributes}
    ><span className="pointer-events-none block size-4 rounded-full border border-primary bg-background" /></SliderPrimitive.Thumb>)}
  </SliderPrimitive.Root>
}

export { Slider }
