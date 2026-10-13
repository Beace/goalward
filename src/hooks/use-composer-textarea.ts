import { useLayoutEffect, type RefObject } from 'react'

/** Task and goal composers grow immediately with text and available pane width. */
export function useComposerTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, layoutKey: string) {
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const resize = () => { node.style.height = '0px'; node.style.height = `${Math.min(160, Math.max(40, node.scrollHeight))}px` }
    resize()
    let width = node.clientWidth
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; resize() }
    })
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [ref, value, layoutKey])
}
