import { Brain } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface ReasoningEffortOption {
  value: string
  label: string
  disabled?: boolean
}

interface ReasoningEffortSelectProps {
  id?: string
  label: string
  value?: unknown
  options: ReasoningEffortOption[]
  onChange: (value: string | undefined) => void
  allowModelDefault?: boolean
  modelDefaultLabel?: string
  disabled?: boolean
  compact?: boolean
  className?: string
  snapshotLabel?: string
  motion?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/** A single setting picker shared by model defaults and per-member overrides. */
export function ReasoningEffortSelect({ id, label, value, options, onChange, allowModelDefault, modelDefaultLabel = '跟随模型默认', disabled, compact, className, snapshotLabel, motion, side }: ReasoningEffortSelectProps) {
  const malformed = value !== undefined && (typeof value !== 'string' || !value || value.startsWith('__'))
  const selected = snapshotLabel ? '__snapshot__' : malformed ? '__invalid__' : typeof value === 'string' ? value : allowModelDefault ? '__model_default__' : 'inherit'
  const missing = !malformed && typeof value === 'string' && !options.some(option => option.value === value)
  const fullLabel = snapshotLabel ?? (malformed ? '配置无效，请重新选择' : selected === '__model_default__' ? modelDefaultLabel : options.find(option => option.value === selected)?.label ?? `${selected} · 当前配置不适用`)
  const shortLabel = snapshotLabel
    ? snapshotLabel === 'Runtime 默认' ? '运行时默认' : snapshotLabel.split(' · ').at(-1)
    : malformed ? '配置无效' : selected === '__model_default__' ? '模型默认' : selected === 'inherit' ? '运行时默认' : selected
  return <Select motion={motion} value={selected} disabled={disabled} onValueChange={next => onChange(next === '__model_default__' ? undefined : next)}>
    <SelectTrigger id={id} aria-label={label} title={`${label}：${fullLabel}`} className={cn('w-full min-w-0', compact && 'model-select !mt-0 !mb-0 gap-1', className)}>
      {compact && <Brain className="size-3 shrink-0" />}
      <span className="min-w-0 truncate"><SelectValue>{compact ? shortLabel : undefined}</SelectValue></span>
    </SelectTrigger>
    <SelectContent position="popper" align="end" side={side}>
      {snapshotLabel && <SelectItem value="__snapshot__">{snapshotLabel}</SelectItem>}
      {malformed && <SelectItem value="__invalid__" disabled>配置无效，请重新选择</SelectItem>}
      {allowModelDefault && <SelectItem value="__model_default__">{modelDefaultLabel}</SelectItem>}
      {missing && <SelectItem value={value as string} disabled>{String(value)} · 当前配置不适用</SelectItem>}
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>
}
