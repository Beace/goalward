import { useMemo, useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getPendingRuntimeApprovals, respondRuntimePermission, type RuntimeApproval } from '@/lib/runtime-approvals'
import type { Task } from '@/lib/types'
import { useI18n } from '@/i18n'

function Approval({ request }: { request: RuntimeApproval }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function respond(optionId: string | null) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await respondRuntimePermission(request, optionId) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <Alert className="border-primary/40 bg-accent/40" aria-busy={busy}>
    <ShieldQuestion className="size-4" />
    <AlertTitle className="text-xs">{request.memberName} · {t('等待确认', 'Awaiting approval')}</AlertTitle>
    <AlertDescription className="min-w-0 space-y-2 text-xs">
      <p className="break-words text-foreground">{request.title}</p>
      {request.detail && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-[11px]">{request.detail}</pre>}
      <div className="flex flex-wrap gap-2">
        {request.options.map(option => <Button key={option.optionId} size="sm" variant={option.kind.startsWith('reject') ? 'outline' : 'secondary'} disabled={busy} onClick={() => void respond(option.optionId)}>{option.name}</Button>)}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond(null)}>{t('取消此请求', 'Cancel this request')}</Button>
        {busy && <span role="status" className="self-center text-muted-foreground">{t('正在提交…', 'Submitting…')}</span>}
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </AlertDescription>
  </Alert>
}

export function RuntimeApprovalPanel({ task }: { task: Task }) {
  const { t } = useI18n()
  const requests = useMemo(() => getPendingRuntimeApprovals(task), [task])
  if (!requests.length) return null
  return <div aria-label={t('Runtime 待审批请求', 'Pending runtime approval requests')} className="max-h-64 space-y-2 overflow-y-auto px-4 py-2">{requests.map(request => <Approval key={`${request.runId}:${request.memberId}:${request.id}`} request={request} />)}</div>
}
