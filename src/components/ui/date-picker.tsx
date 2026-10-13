import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { format, isValid, parseISO } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { enUS, zhCN } from 'react-day-picker/locale'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { hoverFeedbackHandlers } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

type DatePickerProps = Omit<ComponentProps<typeof Button>, 'value' | 'onChange' | 'children'> & {
  value: string
  onValueChange: (value: string) => void
  min?: string
  max?: string
}

// Date-only values have no UTC offset. parseISO/format keep the local calendar
// day intact instead of shifting it through a UTC timestamp.
function calendarDate(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = parseISO(value)
  return isValid(date) && format(date, 'yyyy-MM-dd') === value ? date : undefined
}

/** shadcn/ui Date Picker: shared Popover + Calendar, with date-only storage. */
export function DatePicker({ value, onValueChange, min, max, disabled, className, ...props }: DatePickerProps) {
  const { language, t } = useI18n()
  const valueId = useId()
  const [open, setOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const selected = calendarDate(value)
  const earliest = calendarDate(min)
  const latest = calendarDate(max)
  const today = new Date()
  const initialMonth = selected ?? (latest && latest < today ? latest : earliest && earliest > today ? earliest : today)
  const locale = language === 'zh' ? zhCN : enUS
  const displayValue = selected ? format(selected, 'PPP', { locale }) : value || t('选择日期', 'Pick a date')
  const change = (date: Date | undefined) => {
    if (disabled) return
    onValueChange(date ? format(date, 'yyyy-MM-dd') : '')
    setOpen(false)
  }

  return <Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button
        {...props}
        aria-describedby={[props['aria-describedby'], valueId].filter(Boolean).join(' ')}
        type="button"
        variant="outline"
        disabled={disabled}
        data-empty={!value}
        className={cn('date-picker-trigger w-full min-w-0 justify-start text-left font-normal data-[empty=true]:text-muted-foreground', className)}
      >
        <CalendarIcon aria-hidden="true" />
        <span id={valueId} className="truncate">{displayValue}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent ref={contentRef} align="start" className="date-picker-content w-auto p-0" onOpenAutoFocus={event => {
      // Let DayPicker's roving focus choose the day after Radix has activated
      // the nested focus scope, rather than focusing a month navigation button.
      event.preventDefault()
      const content = contentRef.current
      const target = content?.querySelector<HTMLButtonElement>('[data-slot="calendar"] button[tabindex="0"]') ?? content
      target?.focus()
    }} {...hoverFeedbackHandlers<HTMLDivElement>({})}>
      <Calendar
        mode="single"
        locale={locale}
        selected={selected}
        defaultMonth={initialMonth}
        onSelect={change}
        autoFocus
        disabled={[...(earliest ? [{ before: earliest }] : []), ...(latest ? [{ after: latest }] : [])]}
      />
      <div className="date-picker-footer">
        <Button type="button" variant="ghost" size="sm" disabled={!value || disabled} onClick={() => change(undefined)}>{t('清除日期', 'Clear date')}</Button>
      </div>
    </PopoverContent>
  </Popover>
}
