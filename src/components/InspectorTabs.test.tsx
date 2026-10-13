// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InspectorTabs, type InspectorTab } from './InspectorTabs'
afterEach(cleanup)
function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>Expand {n}</button> }
it('retains tool state while switching and supports new descriptors without changing the host', () => {
  const close = vi.fn()
  const tools: InspectorTab[] = [{ id:'trace',label:'Trace',content:<Counter/> }, { id:'preview',label:'Artifact preview',content:<input aria-label="Source location" defaultValue="42"/> }]
  function Host({ tabs }: { tabs: InspectorTab[] }) { const [tab, setTab] = useState('trace'); return <InspectorTabs tabs={tabs} value={tab} onValueChange={setTab} onClose={close}/> }
  const view = render(<Host tabs={tools}/>)
  fireEvent.click(screen.getByText('Expand 0'))
  fireEvent.mouseDown(screen.getByRole('tab', { name:'Artifact preview' }), { button:0, ctrlKey:false })
  expect(screen.queryByRole('button', { name:'Expand 1' })).toBeNull()
  expect(screen.getByText('Expand 1').closest('[role=tabpanel]')?.hasAttribute('inert')).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target:{value:'88'} })
  fireEvent.mouseDown(screen.getByRole('tab', { name:'Trace' }), { button:0, ctrlKey:false })
  expect(screen.getByRole('button', { name:'Expand 1' })).toBeTruthy()
  view.rerender(<Host tabs={[...tools, { id:'terminal',label:'Terminal',content:<p>New tool</p> }]}/>)
  fireEvent.mouseDown(screen.getByRole('tab', { name:'Terminal' }), { button:0, ctrlKey:false })
  expect(screen.getByRole('tabpanel').textContent).toBe('New tool')
  view.rerender(<Host tabs={tools}/>)
  expect(screen.getByRole('button', { name:'Expand 1' })).toBeTruthy()
  fireEvent.mouseDown(screen.getByRole('tab', { name:'Artifact preview' }), { button:0, ctrlKey:false })
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('88')
  fireEvent.click(screen.getByRole('button', { name:'收起检查器' }))
  expect(close).toHaveBeenCalledOnce()
})
it('closes individual tools, keeps the active tool when closing a background tab, and restores focus', () => {
  const closedPanel = vi.fn()
  function Host() {
    const [tabs, setTabs] = useState<InspectorTab[]>([
      {id:'trace',label:'Trace',content:<Counter/>},
      {id:'preview',label:'Artifact preview',content:'Document'},
      {id:'extra',label:'Terminal',content:'Terminal content'},
    ])
    const [selected, setSelected] = useState('trace')
    return <InspectorTabs tabs={tabs} value={selected} onValueChange={setSelected} onClose={closedPanel} onCloseTab={id => setTabs(tabs => tabs.filter(tab => tab.id !== id))}/>
  }
  render(<Host/>)
  fireEvent.click(screen.getByText('Expand 0'))
  fireEvent.click(screen.getByRole('button',{name:'关闭Artifact preview标签'}))
  expect(screen.queryByRole('tab',{name:'Artifact preview'})).toBeNull()
  expect(screen.getByText('Expand 1')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Trace'}))
  fireEvent.click(screen.getByRole('button',{name:'关闭Trace标签'}))
  expect(screen.getByRole('tabpanel').textContent).toBe('Terminal content')
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Terminal'}))
  fireEvent.keyDown(screen.getByRole('tab',{name:'Terminal'}),{key:'Delete'})
  expect(screen.queryByRole('tab')).toBeNull()
  expect(closedPanel).toHaveBeenCalledOnce()
})
