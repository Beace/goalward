import { useEffect, useRef, type CSSProperties } from 'react'
import { CircleCheck, CircleAlert, Info, X } from 'lucide-react'
import { Toaster as Sonner, toast, type ExternalToast } from 'sonner'
import { useI18n } from '@/i18n'

// shadcn/ui Sonner adapter, themed for the desktop workbench.
// One latest notification across pages; updates preserve the mounted toast.
type NoticeKind = 'success' | 'info' | 'error'
type NoticeOptions = Pick<ExternalToast, 'onDismiss' | 'onAutoClose'>
let current: { id: number; message: string; kind: NoticeKind } | undefined
let sequence = 0
const lifetime = (kind: NoticeKind) => kind === 'error' ? 8000 : 5000
const canFocus = (element: HTMLElement | null): element is HTMLElement => Boolean(
  element?.isConnected && element.getClientRects().length && !element.closest('[inert], [aria-hidden="true"]') && !element.matches(':disabled'),
)

function show(kind: NoticeKind, message: string, options: NoticeOptions = {}) {
  const previous = document.querySelector<HTMLElement>('.app-toast[data-front="true"]')
  const exiting = previous?.dataset.removed === 'true'
  const id = current && !exiting ? current.id : ++sequence
  current = { id, kind, message }
  // If a new result arrives during dismissal, continue its visible opacity.
  const initialOpacity = exiting && previous ? getComputedStyle(previous).opacity : '0'
  const finish = () => { if (current?.id === id) current = undefined }
  return toast[kind](<span role={kind === 'error' ? 'alert' : 'status'}>{message}</span>, {
    id,
    duration: previous?.contains(document.activeElement) ? Infinity : lifetime(kind),
    style: { '--toast-initial-opacity': initialOpacity } as CSSProperties,
    onDismiss: item => { finish(); options.onDismiss?.(item) },
    onAutoClose: item => { finish(); options.onAutoClose?.(item) },
  })
}

export const notify = {
  success: (message: string, options?: NoticeOptions) => show('success', message, options),
  info: (message: string, options?: NoticeOptions) => show('info', message, options),
  error: (message: string, options?: NoticeOptions) => show('error', message, options),
}

export function Toaster({ theme = 'system' }: { theme?: 'dark' | 'light' | 'system' }) {
  const { t } = useI18n()
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => () => { current = undefined; toast.dismiss() }, [])
  return <div
    onFocusCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        returnFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
        if (current) {
          const { id, kind, message } = current
          toast(<span role={kind === 'error' ? 'alert' : 'status'}>{message}</span>, { id, duration: Infinity })
        }
      }
    }}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget) && current) {
        const { id, kind, message } = current
        toast(<span role={kind === 'error' ? 'alert' : 'status'}>{message}</span>, { id, duration: lifetime(kind) })
      }
    }}
    onClickCapture={event => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-close-button]')) return
      const target = returnFocus.current
      if (canFocus(target)) target.focus({ preventScroll: true })
    }}
    onKeyDownCapture={event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      const target = returnFocus.current
      if (canFocus(target)) target.focus({ preventScroll: true })
      if (current) { const id = current.id; current = undefined; toast.dismiss(id) }
    }}
  ><Sonner
    theme={theme}
    className="app-toaster"
    position="top-center"
    offset={{ top: 56 }}
    mobileOffset={{ top: 56 }}
    visibleToasts={1}
    closeButton
    swipeDirections={[]}
    customAriaLabel={t('通知（Alt+T）', 'Notifications (Alt+T)')}
    icons={{ success: <CircleCheck size={16} />, info: <Info size={16} />, error: <CircleAlert size={16} />, close: <X size={14} /> }}
    toastOptions={{ unstyled: true, classNames: { toast: 'app-toast' }, closeButtonAriaLabel: t('关闭提示', 'Dismiss notification') }}
  /></div>
}
