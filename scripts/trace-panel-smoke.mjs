import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Synthetic browser-only fixtures. Fresh contexts never read the user's browser
// state and do not invoke Tauri or launch a runtime.
const outputDirectory = 'test-results/trace-panel'
const baseUrl = process.env.TRACE_SMOKE_URL ?? 'http://127.0.0.1:1420'
const timestamp = new Date(Date.now() - 4000).toISOString()
const runtime = { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: 'Trace browser fixture' }
const member = { id: 'trace-member', name: 'Codex', role: '执行', runtimeId: 'codex', modelId: '', model: '', status: 'running', runtime }
const input = { path: 'src/components/TracePanel.tsx', filters: { include: ['tool_call', 'result'], enabled: true, limit: 3, cursor: null }, url: `https://example.invalid/trace/${'long-segment-'.repeat(20)}` }
const result = { ok: true, files: [{ path: 'src/components/TracePanel.tsx', changes: 3 }], message: '已经读取执行过程配置。' }
function record(id, type, item, second = 0) {
  return { id, kind: 'stdout', taskId: 'trace-task', runId: 'trace-run', memberId: member.id, timestamp: new Date(Date.parse(timestamp) + second * 1000).toISOString(), text: `${JSON.stringify({ type, item })}\n` }
}
const firstStart = record('start-1', 'item.started', { id: 'call-1', type: 'mcp_tool_call', server: 'local', tool: 'inspect_config', arguments: input })
const firstEnd = record('end-1', 'item.completed', { id: 'call-1', type: 'mcp_tool_call', server: 'local', tool: 'inspect_config', result }, 3)
const secondStart = record('start-2', 'item.started', { id: 'call-2', type: 'mcp_tool_call', server: 'local', tool: 'inspect_config', arguments: { path: 'src/lib/trace-calls.ts', limit: 1 } }, 1)
const secondEnd = record('end-2', 'item.completed', { id: 'call-2', type: 'mcp_tool_call', server: 'local', tool: 'inspect_config', result: { ok: true, message: '第二个调用独立完成。' } }, 4)
function fixtureTask(events, status = 'running') {
  const runMember = { ...member, status }
  const run = { id: 'trace-run', createdAt: timestamp, prompt: '独立浏览器执行过程验收', directory: '/tmp/trace-panel-fixture', members: [runMember] }
  return { id: 'trace-task', title: '执行过程 · 工具调用展示', directory: '/tmp/trace-panel-fixture', mode: 'solo', members: [member], createdAt: timestamp, runs: [run], events, messages: [
    { id: 'user-message', role: 'user', text: '优化执行过程中的 JSON 展示，将工具开始与结束合并，并区分入参和出参。', createdAt: timestamp },
    { id: 'assistant-message', role: 'assistant', text: '相同调用的生命周期会合并到同一条记录。参数和结果分区展示，JSON 使用缩进、层级线和语法高亮。', createdAt: timestamp },
  ] }
}
const report = { baseUrl, startedAt: new Date().toISOString(), status: 'running', skill: '~/.agents/skills/apple-design/SKILL.md', scope: 'Real TracePanel and full App in isolated browser contexts, synthetic runtime frames only; no native runtime/storage.', scenarios: [], errors: [] }
await mkdir(outputDirectory, { recursive: true })
// test-results is ignored by Vite's watcher; give each generated source a fresh
// module URL so an existing dev server does not serve its previous transform.
await writeFile(`${outputDirectory}/harness.html`, `<!doctype html><html class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?fixture=${Date.now()}"></script></body></html>`)
await writeFile(`${outputDirectory}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TracePanel} from '/src/components/TracePanel'
import {Button} from '/src/components/ui/button'
import '/src/index.css'
const standaloneFixture = ${JSON.stringify({...fixtureTask([record('preview-start','item.started',{id:'call-1',type:'mcp_tool_call',server:'docs',tool:'search',arguments:{query:'Agent runtime',filters:{language:'zh-CN',limit:3}}})]),demo:true})}
const standaloneResult = ${JSON.stringify(record('preview-result','item.completed',{id:'call-1',type:'mcp_tool_call',server:'docs',tool:'search',result:{items:[{title:'Runtime reference',url:'https://example.invalid/docs'}],count:1}},3))}
function newPreview() {
  const now = new Date().toISOString()
  return {...standaloneFixture,createdAt:now,runs:standaloneFixture.runs.map(run=>({...run,createdAt:now})),events:standaloneFixture.events.map(event=>({...event,timestamp:now}))}
}
function Harness() {
  const standalone = window.__fixture === undefined
  const [task,setTask] = useState(()=>window.__fixture ?? newPreview())
  const [width,setWidth] = useState(standalone ? 480 : 336)
  window.__setTrace = setTask
  window.__setWidth = setWidth
  const complete = () => setTask(current=>({...current,events:[current.events[0],{...standaloneResult,timestamp:new Date().toISOString()}],runs:current.runs.map(run=>({...run,members:run.members.map(member=>({...member,status:'completed'}))}))}))
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',minWidth:0}}>
    {standalone && <header style={{display:'flex',alignItems:'center',justifyContent:'center',flexWrap:'wrap',gap:12,padding:12,borderBottom:'1px solid var(--color-border)'}}>
      <span style={{color:'var(--color-muted-foreground)'}}>执行过程交互预览 · 合成数据</span>
      <Button variant="secondary" size="sm" onClick={()=>setTask(newPreview())}>开始 / 重置</Button>
      <Button size="sm" onClick={complete} disabled={task.events.length > 1}>返回结果</Button>
    </header>}
    <div style={{flex:1,minHeight:0,display:'flex',justifyContent:'center',minWidth:0}}><div id="trace-fixture" style={{width,maxWidth:'100vw',height:'100%',minWidth:0,borderLeft:'1px solid var(--color-border)',borderRight:'1px solid var(--color-border)'}}><TracePanel task={task} run={task.runs[0]} onClose={()=>{window.__closed=true}} onExport={()=>{window.__exported=true}} /></div></div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Harness/>)
`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let activePage
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function update(page, events, status = 'running') {
  await page.evaluate(task => window.__setTrace(task), fixtureTask(events, status))
  await settle(page)
}
async function geometry(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.trace-panel').getBoundingClientRect()
    return { pageOverflow: document.documentElement.scrollWidth - innerWidth, panelWidth: panel.width, childOverflow: Array.from(document.querySelectorAll('.trace-trigger,.trace-call-payload,.trace-detail,.trace-controls')).filter(node => { const rect=node.getBoundingClientRect(); return rect.left < panel.left - 1 || rect.right > panel.right + 1 }).map(node => ({ className: node.className, right: node.getBoundingClientRect().right, panelRight: panel.right })) }
  })
}
async function spinnerFrames(page) {
  return page.locator('.trace-loading').first().evaluate(node => new Promise(resolve => {
    const samples=[]
    const begin=performance.now()
    const frame = () => {
      const style=getComputedStyle(node)
      samples.push({ at: performance.now()-begin, transform: style.transform, animationName: style.animationName })
      if(performance.now()-begin < 180) requestAnimationFrame(frame)
      else resolve(samples)
    }
    requestAnimationFrame(frame)
  }))
}
async function launchHarness(width, height, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
  await context.addInitScript(task => {
    window.__fixture=task
    window.__copies=[]
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copies.push(text)}}})
  }, fixtureTask([firstStart]))
  const page = await context.newPage()
  activePage=page
  page.on('pageerror',error=>report.errors.push(error.message))
  await page.goto(`${baseUrl}/${outputDirectory}/harness.html`)
  await expect(page.locator('.trace-event')).toHaveCount(1)
  assert.equal(await page.evaluate(()=>Boolean(window.__TAURI_INTERNALS__)),false)
  return {context,page}
}
try {
  for (const [width,height] of [[1536,960],[1280,720]]) {
    const {context,page} = await launchHarness(width,height)
    const scenario = { viewport: {width,height}, checks: {} }
    report.scenarios.push(scenario)
    try {
      const row=page.locator('.trace-event').first()
      await expect(row).toHaveAttribute('data-call-status','running')
      await expect(row.locator('.trace-trigger')).toHaveAttribute('aria-expanded','true')
      await expect(row.getByText('执行中',{exact:true})).toBeVisible()
      await expect(row.locator('.trace-call-output')).toHaveAttribute('aria-busy','true')
      await expect(row.getByText('等待工具返回结果…',{exact:true})).toBeVisible()
      const spin=await spinnerFrames(page)
      assert(new Set(spin.map(sample=>sample.transform)).size > 2,'Normal running indicator must rotate across real animation frames')
      scenario.checks.running={animationFrames:spin, textFeedback:true}
      const payload=row.locator('.trace-call-input pre')
      assert.equal(await payload.textContent(),JSON.stringify(input,null,2))
      const colors=await payload.evaluate(node=>Object.fromEntries(['key','string','number','boolean','null'].map(type=>[type,getComputedStyle(node.querySelector('.trace-json-'+type)).color])))
      assert(new Set(Object.values(colors)).size>=4,'JSON token types must have distinct visual colors')
      assert(await payload.locator('.trace-json-indent').count()>4,'Nested JSON must show indentation guides')
      scenario.checks.json={formatted:true,colors,indentGuides:await payload.locator('.trace-json-indent').count()}
      await row.evaluate(node=>{window.__firstRow=node;window.__firstTrigger=node.querySelector('.trace-trigger')})
      await update(page,[firstStart,secondStart])
      await expect(page.locator('.trace-event')).toHaveCount(2)
      await expect(page.locator('[data-call-status=running]')).toHaveCount(2)
      await update(page,[firstStart,secondStart,firstEnd])
      await expect(page.locator('.trace-event')).toHaveCount(2)
      await expect(row).toHaveAttribute('data-call-status','completed')
      await expect(page.locator('.trace-event').nth(1)).toHaveAttribute('data-call-status','running')
      assert.equal(await row.evaluate(node=>node===window.__firstRow&&node.querySelector('.trace-trigger')===window.__firstTrigger),true,'Completion must preserve row/trigger DOM identity')
      await expect(row.locator('.trace-trigger')).toHaveAttribute('aria-expanded','true')
      await expect(row.locator('.trace-loading')).toHaveCount(0)
      await expect(row.locator('.trace-time-range')).toContainText('→')
      await expect(row.locator('.trace-duration')).toHaveText('3.0 s')
      assert.equal(await row.locator('.trace-call-output pre').textContent(),JSON.stringify({result},null,2))
      scenario.checks.lifecycle={sameRowAndTrigger:true,keepsExpanded:true,completedAndRunningIndependent:true,pairedTimeAndDuration:true}
      await row.getByRole('button',{name:'复制入参',exact:true}).click()
      await row.getByRole('button',{name:'复制出参',exact:true}).click()
      await row.getByRole('button',{name:'原始记录 2',exact:true}).click()
      const raw=row.getByRole('button',{name:'复制事件输出',exact:true})
      await expect(raw).toHaveCount(2)
      await raw.nth(0).click()
      await raw.nth(1).click()
      assert.deepEqual(await page.evaluate(()=>window.__copies),[JSON.stringify(input,null,2),JSON.stringify({result},null,2),firstStart.text,firstEnd.text])
      scenario.checks.clipboard={inputOutputSeparate:true,rawStartExact:true,rawEndExact:true}
      await row.getByRole('button',{name:'原始记录 2',exact:true}).click()
      const trigger=row.locator('.trace-trigger')
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(trigger).toHaveAttribute('aria-expanded','false')
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Space')
      await expect(trigger).toHaveAttribute('aria-expanded','true')
      await trigger.evaluate(node=>{for(let index=0;index<8;index++) node.click()})
      await expect(trigger).toHaveAttribute('aria-expanded','true')
      scenario.checks.keyboard={enterCloses:true,spaceOpens:true,focusRetained:true,rapidToggleCount:8}
      for(const panelWidth of [336,280]) {
        await page.evaluate(width=>window.__setWidth(width),panelWidth)
        await settle(page)
        const dimensions=await geometry(page)
        await page.screenshot({path:`${outputDirectory}/panel-${width}-${panelWidth}.png`})
        assert(dimensions.pageOverflow<=1,`Page overflow: ${JSON.stringify(dimensions)}`)
        assert.equal(dimensions.childOverflow.length,0,`Trace content exceeds its panel: ${JSON.stringify(dimensions)}`)
        const preMetrics=await payload.evaluate(node=>({clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,overflow:getComputedStyle(node).overflowX,fontSize:getComputedStyle(node).fontSize,whiteSpace:getComputedStyle(node).whiteSpace}))
        assert(preMetrics.clientWidth>=180,'Narrow code payload must retain a readable inner viewport')
        assert.equal(preMetrics.overflow,'auto')
        scenario.checks[`width${panelWidth}`]={...dimensions,payload:preMetrics}
      }
      // Append a late result below a reader who has intentionally scrolled into
      // history. This verifies a real React streamed-data update, not a remount.
      const history=Array.from({length:45},(_,index)=>record(`history-${index}`,'item.completed',{id:`history-call-${index}`,type:'command_execution',command:`printf 'trace fixture ${index}'`,aggregated_output:`fixture ${index}`,exit_code:0},index))
      await update(page,[...history,firstStart,secondStart])
      const scroller=page.locator('[data-radix-scroll-area-viewport]')
      await scroller.evaluate(node=>{node.scrollTop=600})
      const before=await scroller.evaluate(node=>node.scrollTop)
      assert(before>=599,'Fixture must provide a real scrollable history')
      await update(page,[...history,firstStart,secondStart,firstEnd,secondEnd])
      const after=await scroller.evaluate(node=>node.scrollTop)
      assert(Math.abs(before-after)<=1,`Late result moved reading position from ${before} to ${after}`)
      scenario.checks.lateResultScroll={before,after,realReactUpdate:true}
    } finally { await context.close() }
  }
  {
    const {context,page}=await launchHarness(1280,720,'reduce')
    try {
      const spin=await spinnerFrames(page)
      assert.equal(new Set(spin.map(sample=>sample.transform)).size,1,'Reduced-motion loading must remain static')
      assert(spin.every(sample=>sample.animationName==='none'),'Reduced-motion must remove the spinner animation')
      await expect(page.getByText('执行中',{exact:true})).toBeVisible()
      await page.screenshot({path:`${outputDirectory}/reduced-motion.png`})
      report.scenarios.push({viewport:{width:1280,height:720},reducedMotion:'reduce',checks:{staticIndicator:true,statusLabelRetained:true,frames:spin}})
    } finally { await context.close() }
  }
  {
    const {context,page}=await launchHarness(1536,960)
    try {
      const showcaseStart=record('showcase-start','item.started',{id:'call-1',type:'mcp_tool_call',server:'docs',tool:'search',arguments:{query:'Agent runtime',filters:{language:'zh-CN',limit:3}}})
      const showcaseEnd=record('showcase-end','item.completed',{id:'call-1',type:'mcp_tool_call',server:'docs',tool:'search',result:{items:[{title:'Runtime reference',url:'https://example.invalid/docs'}],count:1}},3)
      await update(page,[showcaseStart,secondStart,showcaseEnd])
      await page.evaluate(()=>window.__setWidth(480))
      const first=page.locator('.trace-event').first().locator('.trace-trigger')
      if(await first.getAttribute('aria-expanded')==='false') await first.click()
      const last=page.locator('.trace-event').last().locator('.trace-trigger')
      if(await last.getAttribute('aria-expanded')==='true') await last.click()
      await page.evaluate(()=>{document.activeElement?.blur();document.querySelector('[data-radix-scroll-area-viewport]').scrollTop=0})
      await page.mouse.move(10,10)
      await settle(page)
      await expect(page.locator('.trace-event[data-call-status=running]')).toBeInViewport()
      await page.locator('#trace-fixture').screenshot({path:`${outputDirectory}/preview.png`})
      report.scenarios.push({viewport:{width:1536,height:960},surface:'inspector-preview',checks:{panelWidth:480,completedAndRunningVisible:true,shortFixtureForShowcase:true}})
    } finally {await context.close()}
  }
  for(const [width,height] of [[1536,960],[1280,720]]) {
    const task=fixtureTask([firstStart,secondStart,firstEnd,secondEnd],'completed')
    const fixture={version:1,settings:{runtimes:[runtime],models:[],providers:[],defaultRuntime:'codex',defaultMode:'solo',maxParallel:3,defaultDirectory:'/tmp',outputLimit:100000},tasks:[task],activeTaskId:task.id,onboarding:{version:1,completedAt:timestamp,outcome:'configured'}}
    const context=await browser.newContext({viewport:{width,height}})
    await context.addInitScript(state=>localStorage.setItem('goalward.preview.v1',JSON.stringify(state)),fixture)
    const page=await context.newPage()
    activePage=page
    page.on('pageerror',error=>report.errors.push(error.message))
    try {
      await page.goto(baseUrl)
      await expect(page.getByRole('heading',{name:task.title,exact:true})).toBeVisible()
      assert.equal(await page.evaluate(()=>Boolean(window.__TAURI_INTERNALS__)),false)
      await expect(page.locator('.trace-event')).toHaveCount(2)
      const first=page.locator('.trace-event').first().locator('.trace-trigger')
      if(await first.getAttribute('aria-expanded')==='false') await first.click()
      const last=page.locator('.trace-event').last().locator('.trace-trigger')
      if(await last.getAttribute('aria-expanded')==='true') await last.click()
      await page.locator('.trace-panel [data-radix-scroll-area-viewport]').evaluate(node=>{node.scrollTop=0})
      await settle(page)
      const dimensions=await geometry(page)
      assert(dimensions.pageOverflow<=1)
      assert.equal(dimensions.childOverflow.length,0,`App trace overflow: ${JSON.stringify(dimensions)}`)
      await page.screenshot({path:`${outputDirectory}/workbench-${width}.png`})
      report.scenarios.push({viewport:{width,height},surface:'full-app',checks:{...dimensions,groupedCalls:2,isolatedLocalStorage:true}})
    } finally {await context.close()}
  }
  {
    // No addInitScript: the public preview must work from a directly opened URL.
    const context=await browser.newContext({viewport:{width:1280,height:960}})
    const page=await context.newPage()
    activePage=page
    page.on('pageerror',error=>report.errors.push(error.message))
    try {
      await page.goto(`${baseUrl}/${outputDirectory}/harness.html`)
      await expect(page.getByText('执行过程交互预览 · 合成数据',{exact:true})).toBeVisible()
      const row=page.locator('.trace-event')
      await expect(row).toHaveCount(1)
      await expect(row).toHaveAttribute('data-call-status','running')
      await row.evaluate(node=>{window.__standaloneRow=node})
      await page.getByRole('button',{name:'返回结果',exact:true}).click()
      await expect(row).toHaveAttribute('data-call-status','completed')
      await expect(row.locator('.trace-call-output')).toContainText('Runtime reference')
      assert.equal(await row.evaluate(node=>node===window.__standaloneRow),true)
      await expect(page.getByRole('button',{name:'返回结果',exact:true})).toBeDisabled()
      await page.screenshot({path:`${outputDirectory}/standalone-preview.png`})
      await page.getByRole('button',{name:'开始 / 重置',exact:true}).click()
      await expect(row).toHaveCount(1)
      await expect(row).toHaveAttribute('data-call-status','running')
      await expect(page.getByRole('button',{name:'返回结果',exact:true})).toBeEnabled()
      await expect(row.getByText('等待工具返回结果…',{exact:true})).toBeVisible()
      assert.equal(await page.evaluate(()=>Boolean(window.__TAURI_INTERNALS__)),false)
      report.scenarios.push({viewport:{width:1280,height:960},surface:'standalone-preview',checks:{directOpen:true,noInjectedFixture:true,startCompleteReset:true,sameRowOnCompletion:true}})
    } finally {await context.close()}
  }
  assert.equal(report.errors.length,0,report.errors.join('\n'))
  report.status='passed'
  console.log(`PASS: trace grouping, lifecycle identity, JSON highlighting, exact clipboard, keyboard, loading/reduced motion, narrow layout and scroll. Artifacts: ${outputDirectory}`)
} catch(error) {
  report.status='failed'
  report.failure=error.stack??String(error)
  if(activePage&&!activePage.isClosed()) await activePage.screenshot({path:`${outputDirectory}/failure.png`}).catch(()=>{})
  throw error
} finally {
  report.finishedAt=new Date().toISOString()
  await writeFile(`${outputDirectory}/report.json`,`${JSON.stringify(report,null,2)}\n`)
  await browser.close()
}
