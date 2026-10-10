import { useState, type ReactNode, type RefObject } from 'react'
import { useResizeHandle } from '@/hooks/use-resize-handle'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useI18n } from '@/i18n'

type Props = { navigation: ReactNode; children: ReactNode; sidebarWidth: RefObject<number> }

export function WorkspaceLayout({ navigation, children, sidebarWidth }: Props) {
  const { t } = useI18n()
  const handle = useResizeHandle()
  const [initialWidth] = useState(sidebarWidth.current)

  return <div className="workspace-body">
    <ResizablePanelGroup id="workspace-navigation-panes" orientation="horizontal">
      <ResizablePanel id="workspace-sidebar" defaultSize={initialWidth} minSize="200px" maxSize="420px"
        groupResizeBehavior="preserve-pixel-size" onResize={size => { sidebarWidth.current = size.inPixels }}>
        {navigation}
      </ResizablePanel>
      <ResizableHandle id="sidebar-resize" elementRef={handle} className="sidebar-resize" aria-label={t('调整侧边栏宽度', 'Resize sidebar')} />
      <ResizablePanel id="workspace-content" minSize="500px" className="workspace-content">{children}</ResizablePanel>
    </ResizablePanelGroup>
  </div>
}
