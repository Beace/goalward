// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InspectorTabs, type InspectorTab } from './InspectorTabs'
afterEach(cleanup)
function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>展开 {n}</button> }
it('retains tool state while switching and supports new descriptors without changing the host', () => {
  const close = vi.fn()
  const tools: InspectorTab[] = [{ id:'trace',label:'执行过程',content:<Counter/> }, { id:'preview',label:'产物预览',content:<input aria-label="源码位置" defaultValue="42"/> }]
  function Host({ tabs }: { tabs: InspectorTab[] }) { const [tab, setTab] = useState('trace'); return <InspectorTabs tabs={tabs} value={tab} onValueChange={setTab} onClose={close}/> }
  const view = render(<Host tabs={tools}/>)
  fireEvent.click(screen.getByText('展开 0'))
  fireEvent.mouseDown(screen.getByRole('tab', { name:'产物预览' }), { button:0, ctrlKey:false })
  expect(screen.queryByRole('button', { name:'展开 1' })).toBeNull()
  expect(screen.getByText('展开 1').closest('[role=tabpanel]')?.hasAttribute('inert')).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target:{value:'88'} })
  fireEvent.mouseDown(screen.getByRole('tab', { name:'执行过程' }), { button:0, ctrlKey:false })
  expect(screen.getByRole('button', { name:'展开 1' })).toBeTruthy()
  view.rerender(<Host tabs={[...tools, { id:'terminal',label:'终端',content:<p>新增工具</p> }]}/>)
  fireEvent.mouseDown(screen.getByRole('tab', { name:'终端' }), { button:0, ctrlKey:false })
  expect(screen.getByRole('tabpanel').textContent).toBe('新增工具')
  view.rerender(<Host tabs={tools}/>)
  expect(screen.getByRole('button', { name:'展开 1' })).toBeTruthy()
  fireEvent.mouseDown(screen.getByRole('tab', { name:'产物预览' }), { button:0, ctrlKey:false })
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('88')
  fireEvent.click(screen.getByRole('button', { name:'收起检查器' }))
  expect(close).toHaveBeenCalledOnce()
})
it('closes individual tools, keeps the active tool when closing a background tab, and restores focus', () => {
  const closedPanel = vi.fn()
  function Host() {
    const [tabs, setTabs] = useState<InspectorTab[]>([
      {id:'trace',label:'执行过程',content:<Counter/>},
      {id:'preview',label:'产物预览',content:'文档'},
      {id:'extra',label:'终端',content:'终端内容'},
    ])
    const [selected, setSelected] = useState('trace')
    return <InspectorTabs tabs={tabs} value={selected} onValueChange={setSelected} onClose={closedPanel} onCloseTab={id => setTabs(tabs => tabs.filter(tab => tab.id !== id))}/>
  }
  render(<Host/>)
  fireEvent.click(screen.getByText('展开 0'))
  fireEvent.click(screen.getByRole('button',{name:'关闭产物预览标签'}))
  expect(screen.queryByRole('tab',{name:'产物预览'})).toBeNull()
  expect(screen.getByText('展开 1')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'执行过程'}))
  fireEvent.click(screen.getByRole('button',{name:'关闭执行过程标签'}))
  expect(screen.getByRole('tabpanel').textContent).toBe('终端内容')
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'终端'}))
  fireEvent.keyDown(screen.getByRole('tab',{name:'终端'}),{key:'Delete'})
  expect(screen.queryByRole('tab')).toBeNull()
  expect(closedPanel).toHaveBeenCalledOnce()
})
