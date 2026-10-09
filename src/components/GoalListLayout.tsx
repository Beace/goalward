import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useResizeHandle } from '@/hooks/use-resize-handle'

export function GoalListLayout({ navigation, children, rememberedWidth, idPrefix = 'goal', resizeLabel = '调整目标列表宽度', contentMinSize = '480px' }: {
  navigation: ReactNode; children: ReactNode; rememberedWidth?: RefObject<number>
  idPrefix?: string; resizeLabel?: string; contentMinSize?: string
}) {
  const localWidth = useRef(window.innerWidth <= 1400 ? 186 : 210)
  const width = rememberedWidth ?? localWidth
  const [initialWidth] = useState(width.current)
  const handle = useResizeHandle()

  if (!navigation) return <>{children}</>
  return <ResizablePanelGroup id={`${idPrefix}-panes`} orientation="horizontal" className="goal-panes">
    <ResizablePanel id={`${idPrefix}-list`} defaultSize={initialWidth} minSize="180px" maxSize="360px"
      groupResizeBehavior="preserve-pixel-size" onResize={size => { width.current = size.inPixels }}>
      {navigation}
    </ResizablePanel>
    <ResizableHandle id={`${idPrefix}-list-resize`} elementRef={handle} className="sidebar-resize" aria-label={resizeLabel} />
    <ResizablePanel id={`${idPrefix}-content`} minSize={contentMinSize} className="goal-split-content">{children}</ResizablePanel>
  </ResizablePanelGroup>
}
