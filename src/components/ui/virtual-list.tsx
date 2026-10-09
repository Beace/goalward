import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, measureElement, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { ScrollArea } from './scroll-area'

/** Dynamic-height windowing on the shared Radix scroll surface. No row entrance motion. */
export function VirtualList<T>({ items, getKey, renderItem, label, empty }: {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  label: string
  empty?: ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const pendingFocus = useRef<number | null>(null)
  const focusedIndex = focusedKey === null ? -1 : items.findIndex(item => getKey(item) === focusedKey)
  const getItemKey = useCallback((index: number) => getKey(items[index]), [items, getKey])
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range)
    // Keep keyboard focus mounted even when the user scrolls it outside the window.
    if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex)
    return indexes.sort((a, b) => a - b)
  }, [focusedIndex])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => 96,
    overscan: 4,
    paddingStart: 10,
    paddingEnd: 20,
    initialRect: { width: 336, height: 720 },
    // Keep the last valid estimate while an inspector is hidden or before layout.
    observeElementRect: (instance, callback) => observeElementRect(instance, rect => {
      if (rect.height > 0) callback(rect)
    }),
    measureElement: (element, entry, instance) => measureElement(element, entry, instance) || 96,
    rangeExtractor,
  })
  const rows = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    const target = list.current?.querySelector<HTMLButtonElement>(`[data-index="${pendingFocus.current}"] [data-virtual-heading]`)
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null }
  })
  return <ScrollArea className="flex-1 min-h-0" viewportRef={viewport} viewportProps={{ style: { overflowAnchor: 'none' } }}>
    {items.length === 0 ? empty : <div ref={list} role="list" aria-label={label} className="virtual-list" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null)
      }}
      onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-virtual-heading]') || event.altKey || event.ctrlKey || event.metaKey) return
        const index = Number(event.target.closest('[data-index]')?.getAttribute('data-index'))
        const target = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
        if (target === null) return
        event.preventDefault()
        const next = Math.max(0, Math.min(items.length - 1, target))
        pendingFocus.current = next
        setFocusedKey(getKey(items[next]))
        virtualizer.scrollToIndex(next, { align: 'auto' })
      }}>
      {rows.map(row => <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} role="listitem" aria-posinset={row.index + 1} aria-setsize={items.length}
        onFocusCapture={() => setFocusedKey(getKey(items[row.index]))}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', padding: '0 10px', transform: `translateY(${row.start}px)`, display: 'flow-root' }}>
        {renderItem(items[row.index], row.index)}
      </div>)}
    </div>}
  </ScrollArea>
}
