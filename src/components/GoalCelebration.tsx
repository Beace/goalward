import { useEffect, useRef } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { quietSpring, quickFade } from '@/lib/motion'
import { useI18n } from '@/i18n'
import './goal-celebration.css'

/** Mounted only after a user confirmation has actually been committed. */
export function GoalCelebration({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const origin = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const dismissCallback = useRef(onDismiss)
  dismissCallback.current = onDismiss
  useEffect(() => { const timer = window.setTimeout(() => { if (!document.activeElement?.closest('.goal-celebration')) dismissCallback.current() }, 5000); return () => window.clearTimeout(timer) }, [])
  const dismiss = () => {
    // Closing with the keyboard restores an existing workspace control; appearance never focuses the notice.
    if (origin.current?.isConnected && !origin.current.closest('[aria-hidden="true"], [inert], [hidden]')) origin.current.focus({ preventScroll: true })
    else document.querySelector<HTMLElement>('.goals-page [data-slot="tabs-trigger"][data-state="active"]')?.focus({ preventScroll: true })
    onDismiss()
  }
  return <>
    {!reduced && <div className="goal-celebration-particles" aria-hidden="true">{Array.from({ length: 16 }, (_, index) =>
      <motion.i key={index} style={{ left: `${3 + index * 6.2}%` }} initial={{ x: 0, y: -24 - (index % 4) * 16, rotate: index % 2 ? -35 : 35, opacity: 0 }} animate={{ x: index % 2 ? 54 : -54, y: window.innerHeight + 32, rotate: index % 2 ? 65 : -65, opacity: 1 }} transition={{ x: quietSpring, y: quietSpring, rotate: quietSpring, opacity: quickFade }} />
    )}</div>}
    <motion.div className="goal-celebration" initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? { duration: 0 } : quickFade} onFocusCapture={event => {
      if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) origin.current = event.relatedTarget
    }}>
    <CheckCircle2 size={18} /><span role="status">{t('目标已明确，开始安排下一步。', 'Goal clarified. Let’s plan the next steps.')}</span>
    <Button variant="ghost" size="icon-sm" aria-label={t('关闭目标确认提示', 'Dismiss goal confirmation')} title={t('关闭', 'Dismiss')} onClick={dismiss} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismiss() } }}><X size={14} /></Button>
    </motion.div>
  </>
}
