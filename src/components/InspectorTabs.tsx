import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import './inspector-tabs.css'

export interface InspectorTab {
  id: string
  label: string
  icon?: ReactNode
  content: ReactNode
  actions?: ReactNode
}

/** Stable ids keep each tool mounted while switching tabs, preserving its view state. */
export function InspectorTabs({ tabs, value, onValueChange, onClose, onCloseTab }: {
  tabs: InspectorTab[]
  value: string
  onValueChange: (id: string) => void
  onClose: () => void
  onCloseTab?: (id: string) => void
}) {
  const selected = tabs.find(tab => tab.id === value) ?? tabs[0]
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterClose = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (focusAfterClose.current) {
      triggers.current.get(focusAfterClose.current)?.focus({ preventScroll: true })
      focusAfterClose.current = undefined
    }
  }, [tabs])
  function closeTab(id: string) {
    const index = tabs.findIndex(tab => tab.id === id)
    const next = selected?.id === id ? tabs[index + 1] ?? tabs[index - 1] : selected
    focusAfterClose.current = next?.id
    if (next && next.id !== selected?.id) onValueChange(next.id)
    onCloseTab?.(id)
    if (tabs.length === 1) onClose()
  }
  return <Tabs className="inspector-tabs" value={selected?.id ?? ''} onValueChange={onValueChange}>
    <div className="inspector-tabs-heading">
      <TabsList aria-label="右侧工具面板">{tabs.map(tab => <div key={tab.id} className="inspector-tab-label" data-closable={Boolean(onCloseTab)}>
        <TabsTrigger value={tab.id} ref={node => { if (node) triggers.current.set(tab.id, node); else triggers.current.delete(tab.id) }}
          onKeyDown={event => { if (event.key === 'Delete' && onCloseTab) { event.preventDefault(); closeTab(tab.id) } }}>{tab.icon}{tab.label}</TabsTrigger>
        {onCloseTab && <Button className="inspector-tab-close" variant="ghost" size="icon-sm" tabIndex={selected?.id === tab.id ? 0 : -1}
          title={`关闭${tab.label}标签`} aria-label={`关闭${tab.label}标签`} onClick={() => closeTab(tab.id)}><X/></Button>}
      </div>)}</TabsList>
      <div className="inspector-tabs-actions">{selected?.actions}<Button variant="ghost" size="icon-sm" title="收起检查器" aria-label="收起检查器" onClick={onClose}><X/></Button></div>
    </div>
    {tabs.map(tab => <TabsContent key={tab.id} value={tab.id} forceMount hidden={tab.id !== selected?.id} inert={tab.id !== selected?.id} className="inspector-tab-content">{tab.content}</TabsContent>)}
  </Tabs>
}
