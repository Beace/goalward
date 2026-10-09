import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Frame-level checks run the actual shared component, TracePanel and Settings.
// All fixtures and localStorage live in new browser contexts; no native runtime
// or existing browser profile is used.
const directory = 'test-results/collapsible-motion'
const baseUrl = process.env.TRACE_SMOKE_URL ?? 'http://127.0.0.1:1420'
const timestamp = new Date().toISOString()
const runtime = { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: 'Isolated motion fixture' }
const member = { id: 'motion-member', name: 'Codex', role: '执行', runtimeId: 'codex', modelId: '', model: '', status: 'running', runtime }
function record(id, type, item) {
  return { id, kind: 'stdout', taskId: 'motion-task', runId: 'motion-run', memberId: member.id, timestamp, text: JSON.stringify({ type, item }) + '\n' }
}
const start = record('motion-start', 'item.started', { id: 'motion-call', type: 'command_execution', command: 'printf "synthetic trace"', cwd: '/tmp/motion-fixture' })
const end = record('motion-end', 'item.completed', { id: 'motion-call', type: 'command_execution', command: 'printf "synthetic trace"', aggregated_output: 'synthetic trace', exit_code: 0 })
function fixture(events = [start, end]) {
  return { id: 'motion-task', title: '折叠动效验收', directory: '/tmp/motion-fixture', mode: 'solo', members: [member], createdAt: timestamp, messages: [], runs: [{ id: 'motion-run', createdAt: timestamp, prompt: 'Animation QA', directory: '/tmp/motion-fixture', members: [member] }], events }
}
const history = Array.from({ length: 35 }, (_, index) => record(`history-${index}`, 'item.completed', { id: `history-call-${index}`, type: 'command_execution', command: `printf "fixture ${index}"`, aggregated_output: `fixture ${index}`, exit_code: 0 }))
const report = { status: 'running', startedAt: timestamp, baseUrl, skill: '~/.agents/skills/apple-design/SKILL.md', scope: 'Real presentation-frame geometry, arrows, interruption, nested layout, keyboard/focus, reduced motion, streamed updates and Settings integration. Synthetic isolated browser state only.', scenarios: [], errors: [] }
await mkdir(directory, { recursive: true })
await writeFile(`${directory}/harness.html`, `<!doctype html><html class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?fixture=${Date.now()}"></script></body></html>`)
await writeFile(`${directory}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TracePanel} from '/src/components/TracePanel'
import {Button} from '/src/components/ui/button'
import {Collapsible,CollapsibleTrigger,CollapsibleContent,CollapsibleIndicator} from '/src/components/ui/collapsible'
import '/src/index.css'
const initialTask=${JSON.stringify(fixture())}
function Harness(){
  const [open,setOpen]=useState(false)
  const [task,setTask]=useState(initialTask)
  const [lines,setLines]=useState(4)
  window.__motionControl=setOpen
  window.__motionGrow=()=>setLines(value=>value+5)
  window.__setTrace=setTask
  return <div style={{height:'100vh',display:'flex',minWidth:0}}>
    <main style={{width:360,maxWidth:'40vw',padding:24,overflow:'auto'}}>
      <p style={{marginBottom:16,color:'var(--color-muted-foreground)'}}>折叠动画交互验收 · 合成数据</p>
      <Collapsible id="controlled-root" open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild><Button id="controlled-trigger" variant="secondary"><CollapsibleIndicator size={14}/>受控折叠</Button></CollapsibleTrigger>
        <CollapsibleContent id="controlled-content"><div style={{padding:16,border:'1px solid var(--color-border)'}}>
          <input id="controlled-input" aria-label="折叠内输入框" defaultValue="可聚焦内容"/>
          {Array.from({length:lines},(_,index)=><p key={index} style={{height:32}}>内容第 {index+1} 行</p>)}
          <Button id="inside-close" onClick={()=>setOpen(false)}>从内容关闭</Button>
        </div></CollapsibleContent>
      </Collapsible>
      <Button id="outside-next" variant="ghost" style={{marginTop:20}}>下一个焦点</Button>
      <div style={{marginTop:24,display:'flex',gap:8,flexWrap:'wrap'}}><Button variant="outline" onClick={()=>setOpen(value=>!value)}>外部切换</Button><Button variant="outline" onClick={()=>setLines(value=>value+2)}>增加内容</Button></div>
    </main>
    <div id="trace-fixture" style={{width:480,minWidth:280,maxWidth:'60vw',height:'100%',borderLeft:'1px solid var(--color-border)',borderRight:'1px solid var(--color-border)'}}><TracePanel task={task} run={task.runs[0]} onClose={()=>{}} onExport={()=>{}}/></div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Harness/>);
`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let activePage
async function launch(width, height, reducedMotion = 'no-preference', state) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, recordVideo: { dir: `${directory}/video`, size: { width, height } } })
  if (state) await context.addInitScript(value => localStorage.setItem('goalward.preview.v1', JSON.stringify(value)), state)
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(state ? baseUrl : `${baseUrl}/${directory}/harness.html`)
  await expect(page.locator(state ? '.settings-nav' : '#controlled-trigger')).toBeVisible()
  assert.equal(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), false)
  return { context, page }
}
async function frames(page, { content, trigger, parent, actions = [], duration = 1000 }) {
  return page.evaluate(async config => {
    const samples = []
    const actionLog = []
    const begin = performance.now()
    let index = 0
    const read = () => {
      const node = document.querySelector(config.content)
      const button = document.querySelector(config.trigger)
      const outer = config.parent ? document.querySelector(config.parent) : null
      const arrow = button?.querySelector('svg')
      const transform = arrow ? getComputedStyle(arrow).transform : 'none'
      const matrix = transform === 'none' ? null : new DOMMatrixReadOnly(transform)
      return { at: performance.now() - begin, height: node?.getBoundingClientRect().height ?? 0, angle: matrix ? Math.atan2(matrix.b, matrix.a) * 180 / Math.PI : 0, motion: node?.dataset.collapsibleMotion, hidden: node?.hidden ?? true, inert: node?.inert ?? false, expanded: button?.getAttribute('aria-expanded'), focusedId: document.activeElement?.id, parentHeight: outer?.getBoundingClientRect().height, parentMotion: outer?.dataset.collapsibleMotion, scroll: document.querySelector('.trace-panel [data-radix-scroll-area-viewport]')?.scrollTop }
    }
    samples.push(read())
    return new Promise(resolve => {
      const tick = () => {
        const now = performance.now() - begin
        while (index < config.actions.length && now >= config.actions[index].at) {
          const action = config.actions[index++]
          const before = read()
          if (action.selector) document.querySelector(action.selector).click()
          if ('open' in action) window.__motionControl(action.open)
          if (action.grow) window.__motionGrow()
          if (action.task) window.__setTrace(action.task)
          actionLog.push({ action, before, after: read() })
        }
        samples.push(read())
        if (now < config.duration) requestAnimationFrame(tick)
        else resolve({ samples, actions: actionLog })
      }
      requestAnimationFrame(tick)
    })
  }, { content, trigger, parent, actions, duration })
}
function intermediate(samples, field = 'height') {
  const values = samples.map(sample => sample[field])
  const min = Math.min(...values), max = Math.max(...values)
  return new Set(values.filter(value => value > min + .5 && value < max - .5).map(value => value.toFixed(2))).size
}
function assertAnimation(result, label, direction) {
  const { samples } = result
  assert(intermediate(samples) >= 3, `${label}: expected >2 actual intermediate heights, got ${intermediate(samples)}`)
  assert(intermediate(samples, 'angle') >= 3, `${label}: arrow must rotate with actual intermediate angles`)
  const first = samples[0], last = samples.at(-1)
  assert.equal(last.expanded, String(direction === 'open'), `${label}: aria-expanded endpoint`)
  assert.equal(last.motion, 'idle', `${label}: animation must settle`)
  if (direction === 'closed') assert(last.height < .5, `${label}: closed content must have zero height`)
  else assert(last.height > 20, `${label}: open content must have measurable height`)
  const max = Math.max(...samples.map(sample => sample.height))
  const min = Math.min(...samples.map(sample => sample.height))
  const differences = samples.slice(1).map((sample, index) => sample.height - samples[index].height)
  const wrongDirection = differences.filter(value => direction === 'open' ? value < -1 : value > 1)
  assert.equal(wrongDirection.length, 0, `${label}: ordinary toggles must not bounce`)
  assert(max >= Math.max(first.height, last.height) - .5 && min >= -.5)
  return { intermediateHeights: intermediate(samples), intermediateAngles: intermediate(samples, 'angle'), firstHeight: first.height, finalHeight: last.height, finalAngle: last.angle, frames: result }
}
async function identify(page, root, name) {
  return page.locator(root).evaluate((node, name) => {
    const trigger = node.querySelector(':scope > [data-slot=collapsible-trigger]')
    const content = node.querySelector(':scope > [data-slot=collapsible-content]')
    if (!trigger || !content) throw new Error(`Missing direct trigger/content for ${name}`)
    trigger.dataset.motionTest = `${name}-trigger`
    content.dataset.motionTest = `${name}-content`
    return { trigger: `[data-motion-test="${name}-trigger"]`, content: `[data-motion-test="${name}-content"]` }
  }, name)
}
async function idle(page, content) { await expect(page.locator(content)).toHaveAttribute('data-collapsible-motion', 'idle') }
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    const { context, page } = await launch(width, height)
    const scenario = { viewport: { width, height }, surface: 'shared-and-trace', checks: {} }
    report.scenarios.push(scenario)
    try {
      const row = await identify(page, '.trace-event', 'trace')
      await idle(page, row.content)
      scenario.checks.traceClose = assertAnimation(await frames(page, { ...row, actions: [{ at: 0, selector: row.trigger }] }), 'Trace collapse', 'closed')
      scenario.checks.traceOpen = assertAnimation(await frames(page, { ...row, actions: [{ at: 0, selector: row.trigger }] }), 'Trace expand', 'open')
      const raw = await identify(page, '.trace-raw-records', 'raw')
      const nestedOpen = await frames(page, { ...raw, parent: row.content, actions: [{ at: 0, selector: raw.trigger }] })
      scenario.checks.rawOpen = assertAnimation(nestedOpen, 'Raw records expand', 'open')
      const differences = nestedOpen.samples.map(sample => sample.parentHeight - sample.height)
      assert(Math.max(...differences) - Math.min(...differences) < 1.5, 'Nested expansion must track direct layout without a second parent spring')
      assert(nestedOpen.samples.every(sample => sample.parentMotion === 'idle'), 'Settled parent must not restart an animation for nested content')
      scenario.checks.rawClose = assertAnimation(await frames(page, { ...raw, parent: row.content, actions: [{ at: 0, selector: raw.trigger }] }), 'Raw records collapse', 'closed')
      const controlled = { trigger: '#controlled-trigger', content: '#controlled-content' }
      const reversal = await frames(page, { ...controlled, actions: [{ at: 0, open: true }, { at: 100, open: false }] })
      assert(intermediate(reversal.samples) > 4, 'Reversal must retain visible animation')
      const action = reversal.actions[1]
      assert(Math.abs(action.before.height - action.after.height) < .5, 'Retargeting must not synchronously jump to an old endpoint')
      const index = reversal.samples.findIndex(sample => sample.at >= action.before.at)
      const firstAfter = reversal.samples.slice(index + 1, index + 4)
      const prior = reversal.samples.slice(Math.max(0, index - 2), index + 1)
      const movingForward = prior.at(-1).height - prior[0].height > 1
      assert(movingForward, 'Reversal fixture must interrupt while opening velocity is nonzero')
      assert(firstAfter.some(sample => sample.height > action.before.height + .2), 'Spring reversal must carry forward opening velocity before turning around')
      const heights = reversal.samples.map(sample => sample.height)
      const maxStep = Math.max(...heights.slice(1).map((value, i) => Math.abs(value - heights[i])))
      assert(maxStep < Math.max(...heights) * .4, 'Reversal must not create a discontinuous presentation jump')
      assert.equal(reversal.samples.at(-1).expanded, 'false')
      assert(reversal.samples.at(-1).height < .5)
      scenario.checks.reversal = { synchronousJump: Math.abs(action.before.height - action.after.height), preservesForwardVelocity: true, maxStep, frames: reversal }
      const rapid = await frames(page, { ...controlled, actions: [true, false, true, false, true, false, true].map((open, index) => ({ at: index * 45, open })), duration: 1400 })
      assert.equal(rapid.samples.at(-1).expanded, 'true')
      assert.equal(rapid.samples.at(-1).motion, 'idle')
      assert(rapid.samples.at(-1).height > 150)
      scenario.checks.rapidToggle = { count: 7, finalOpen: true, frames: rapid }
      await page.locator('#controlled-input').focus()
      await expect(page.locator('#controlled-input')).toBeFocused()
      const focusClose = await frames(page, { ...controlled, actions: [{ at: 0, open: false }] })
      scenario.checks.focus = { frames: focusClose }
      await expect(page.locator('#controlled-trigger')).toBeFocused()
      assert(focusClose.samples.slice(2).filter(sample => sample.expanded === 'false').every(sample => sample.inert || sample.hidden), 'Closing subtree must become inert/hidden immediately')
      await page.keyboard.press('Tab')
      await expect(page.locator('#outside-next')).toBeFocused()
      await page.locator('#controlled-trigger').focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('#controlled-trigger')).toHaveAttribute('aria-expanded', 'true')
      await idle(page, controlled.content)
      await page.keyboard.press('Space')
      await expect(page.locator('#controlled-trigger')).toHaveAttribute('aria-expanded', 'false')
      await idle(page, controlled.content)
      scenario.checks.focus = { programmaticCloseRestoresTrigger: true, closedSubtreeSkippedByTab: true, enterAndSpace: true, frames: focusClose }
      await frames(page, { ...controlled, actions: [{ at: 0, open: true }] })
      const growth = await frames(page, { ...controlled, actions: [{ at: 0, grow: true }], duration: 450 })
      assert(growth.samples.every(sample => sample.motion === 'idle'), 'Open content growth must not replay the spring')
      assert(growth.samples.at(-1).height > growth.samples[0].height + 100)
      assert.equal(new Set(growth.samples.map(sample => sample.height.toFixed(2))).size, 2, 'Open content layout updates directly, without animated intermediate heights')
      scenario.checks.contentGrowth = { noReplay: true, frames: growth }
      const preferenceCapture = frames(page, { ...controlled, actions: [{ at: 0, open: false }], duration: 600 })
      await page.waitForTimeout(90)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const preference = await preferenceCapture
      const staticTail = preference.samples.filter(sample => sample.at > 200)
      assert(staticTail.length > 3 && staticTail.every(sample => sample.motion === 'idle' && sample.hidden && sample.height === 0 && Math.abs(sample.angle) < .1), 'Changing reduced-motion preference during a spring must settle height and arrow immediately')
      scenario.checks.liveReducedPreference = { settlesInFlightAnimation: true, frames: preference }
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(task => window.__setTrace(task), fixture([...history, start]))
      await expect(page.locator('.trace-event')).toHaveCount(36)
      const last = page.locator('.trace-event').last()
      const lastTrigger = last.locator(':scope > [data-slot=collapsible-trigger]')
      if (await lastTrigger.getAttribute('aria-expanded') !== 'true') await lastTrigger.click()
      const stream = await identify(page, '.trace-event:last-child', 'stream')
      await idle(page, stream.content)
      const scroller = page.locator('.trace-panel [data-radix-scroll-area-viewport]')
      await scroller.evaluate(node => { node.scrollTop = 400 })
      const streamed = await frames(page, { ...stream, actions: [1, 2, 3].map(index => ({ at: index * 70, task: fixture([...history, start, record(`stream-${index}`, 'item.updated', { id: 'motion-call', type: 'command_execution', command: 'printf "synthetic trace"', aggregated_output: 'streamed fixture\n'.repeat(index * 4) })]) })), duration: 650 })
      assert(streamed.samples.every(sample => sample.motion === 'idle'), 'Each streamed frame must preserve idle/open content without entry replay')
      assert(streamed.samples.every(sample => Math.abs(sample.scroll - 400) < 1), 'Streaming below the reading position must preserve scroll')
      await expect(last.locator('.trace-call-output')).toContainText('streamed fixture')
      scenario.checks.streaming = { noReplay: true, preservedScroll: 400, frames: streamed }
      await page.screenshot({ path: `${directory}/trace-${width}.png` })
    } finally { await context.close() }
  }
  {
    const { context, page } = await launch(1280, 720, 'reduce')
    const scenario = { viewport: { width: 1280, height: 720 }, surface: 'reduced-motion', checks: {} }
    report.scenarios.push(scenario)
    try {
      const controlled = { trigger: '#controlled-trigger', content: '#controlled-content' }
      for (const open of [true, false]) {
        const result = await frames(page, { ...controlled, actions: [{ at: 0, open }], duration: 300 })
        scenario.checks[open ? 'open' : 'close'] = { staticHeight: true, staticArrow: true, frames: result }
        assert.equal(intermediate(result.samples), 0, 'Reduced motion must have no moving height spring')
        assert.equal(intermediate(result.samples, 'angle'), 0, 'Reduced motion must have no rotating arrow spring')
        assert.equal(result.samples.at(-1).expanded, String(open))
        assert.equal(result.samples.at(-1).hidden, !open, 'Reduced-motion endpoint must expose/hide the content correctly')
        assert(result.samples.every(sample => sample.motion === 'idle'))
      }
      const row = await identify(page, '.trace-event', 'trace')
      const close = await frames(page, { ...row, actions: [{ at: 0, selector: row.trigger }], duration: 300 })
      assert.equal(intermediate(close.samples), 0)
      scenario.checks.trace = { staticHeight: true, frames: close }
      await page.screenshot({ path: `${directory}/reduced-motion.png` })
    } finally { await context.close() }
  }
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    const task = fixture()
    const state = { version: 1, settings: { runtimes: [runtime], models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '/tmp', outputLimit: 100000 }, tasks: [task], activeTaskId: task.id, onboarding: { version: 1, completedAt: timestamp, outcome: 'configured' } }
    const { context, page } = await launch(width, height, 'no-preference', state)
    const scenario = { viewport: { width, height }, surface: 'full-app-settings', checks: {} }
    report.scenarios.push(scenario)
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      const trigger = page.getByRole('button', { name: '高级启动配置', exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await trigger.evaluate(node => { node.closest('[data-slot=collapsible]').id = 'settings-advanced' })
      const config = await identify(page, '#settings-advanced', 'settings')
      scenario.checks.open = assertAnimation(await frames(page, { ...config, actions: [{ at: 0, selector: config.trigger }] }), 'Settings advanced expand', 'open')
      await expect(page.getByLabel('启动参数 JSON', { exact: true })).toBeVisible()
      await page.screenshot({ path: `${directory}/settings-${width}.png` })
      scenario.checks.close = assertAnimation(await frames(page, { ...config, actions: [{ at: 0, selector: config.trigger }] }), 'Settings advanced collapse', 'closed')
    } finally { await context.close() }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.status = 'passed'
  console.log(`PASS: real frame geometry, nested springs, reversal velocity, rapid toggles, focus, reduced motion, streaming and Settings. ${directory}/report.json`)
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${directory}/failure.png` }).catch(() => {})
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n')
  await browser.close()
}
