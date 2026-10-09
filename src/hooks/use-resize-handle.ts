import { useLayoutEffect, useRef } from 'react'

/** Complete the shared resizable primitive's pointer lifecycle on cancellation. */
export function useResizeHandle() {
  const handle = useRef<HTMLDivElement>(null)
  const pointer = useRef<PointerEvent | null>(null)

  useLayoutEffect(() => {
    const track = (event: PointerEvent) => { if (event.button === 0 && event.isPrimary) pointer.current = event }
    const finish = () => { pointer.current = null }
    const cancel = () => {
      const last = pointer.current
      pointer.current = null
      // The primitive captures the pointer, but v4 only ends its drag on pointerup.
      // Keep the current width and release its gesture on cancel, blur or unmount.
      if (last && handle.current?.dataset.separator === 'active') {
        document.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: last.pointerId, pointerType: last.pointerType,
          clientX: last.clientX, clientY: last.clientY, button: 0,
        }))
        if (handle.current?.hasPointerCapture(last.pointerId)) handle.current.releasePointerCapture(last.pointerId)
      }
    }
    window.addEventListener('pointerdown', track, true)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('lostpointercapture', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      window.removeEventListener('pointerdown', track, true)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  return handle
}
