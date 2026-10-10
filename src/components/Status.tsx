import { cn } from '@/lib/utils'
import type { RunStatus } from '@/lib/types'
import { CheckCircle2, Circle, CircleAlert, CircleX, LoaderCircle, Square } from 'lucide-react'
import { useI18n } from '@/i18n'
const labels: Record<RunStatus | 'idle', [string, string]> = { idle: ['待命', 'Idle'], running: ['运行中', 'Running'], completed: ['已完成', 'Completed'], failed: ['失败', 'Failed'], stopped: ['已停止', 'Stopped'], interrupted: ['已中断', 'Interrupted'] }
export function Status({ status = 'idle', label }: { status?: RunStatus | 'idle'; label?: string }) {
  const { t } = useI18n()
  const Icon = status === 'running' ? LoaderCircle : status === 'completed' ? CheckCircle2 : status === 'failed' ? CircleX : status === 'stopped' ? Square : status === 'interrupted' ? CircleAlert : Circle
  return <span className={cn('status', `status-${status}`)}><Icon size={12} aria-hidden="true" className={status === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined} />{label ?? t(...labels[status])}</span>
}
