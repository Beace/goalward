import { cn } from '@/lib/utils'
import type { RunStatus } from '@/lib/types'
import { CheckCircle2, Circle, CircleAlert, CircleX, LoaderCircle, Square } from 'lucide-react'
const labels: Record<RunStatus | 'idle', string> = { idle: '待命', running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' }
export function Status({ status = 'idle', label }: { status?: RunStatus | 'idle'; label?: string }) {
  const Icon = status === 'running' ? LoaderCircle : status === 'completed' ? CheckCircle2 : status === 'failed' ? CircleX : status === 'stopped' ? Square : status === 'interrupted' ? CircleAlert : Circle
  return <span className={cn('status', `status-${status}`)}><Icon size={12} aria-hidden="true" className={status === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined} />{label ?? labels[status]}</span>
}
