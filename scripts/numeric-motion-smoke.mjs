import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Actual React components and actual presentation frames; all data is synthetic.
// This does not exercise a native Runtime, model inference, or packaged WebKit.
const output = 'test-results/numeric-motion'
const base = process.env.NUMERIC_SMOKE_URL ?? process.env.NUMERIC_MOTION_SMOKE_URL ?? 'http://127.0.0.1:1420'
const version = Date.now()
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${version}"></script></body></html>`)
await writeFile(`${output}/harness.tsx`, `
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {AnimatedNumber,AnimatedNumberText} from '/src/components/ui/animated-number'
import {AnimatedFill} from '/src/components/ui/animated-fill'
import {Progress} from '/src/components/ui/progress'
import {Button} from '/src/components/ui/button'
import {DashboardPage} from '/src/components/DashboardPage'
import {GoalProgress} from '/src/components/GoalProgress'
import {createInitialState} from '/src/lib/domain'
import {createGoal} from '/src/lib/goals'
import {createWorkspaceTask} from '/src/lib/workspace'
import '/src/index.css'
import '/src/components/workspace.css'
const noop=()=>{}
const seed=createInitialState()
const timestamp=new Date().toISOString()
const goal=createGoal({title:'Number and chart motion verification',expected:'Observe gradual loading while retaining real targets and usable controls',criteria:['Criterion with evidence','Criterion awaiting verification']},timestamp)
goal.criteria[0]={...goal.criteria[0],status:'satisfied',evidence:'Synthetic accepted evidence'}
goal.currentState.entries=[{id:'fixture-metric',kind:'metric',text:'This measurement retains its source and definition',createdAt:timestamp,source:{kind:'user',label:'Synthetic browser evidence'},metric:{name:'Observed metric',value:42.75,unit:'%',observedAt:timestamp,definition:'Synthetic numeric observation for verifying inline decimal and unit layout'}}]
const achieved=createGoal({title:'Completed goal',expected:'Acceptance passed',criteria:['Accepted']},timestamp)
achieved.status='achieved'
achieved.criteria[0]={...achieved.criteria[0],status:'satisfied',evidence:'Synthetic completion evidence'}
const unknown=createGoal({title:'Goal without completion criteria',expected:'Still needs clarification'},timestamp)
const tasks=Array.from({length:8},(_,index)=>{
  const task=createWorkspaceTask(seed.settings,{title:'Synthetic task '+(index+1),directory:'/tmp/numeric-motion',goalId:goal.id})
  task.createdAt=timestamp
  task.businessStatus=index<3?'done':index<5?'in_progress':index===5?'blocked':'todo'
  if(index<3)task.results=[{id:'accepted-'+index,summary:'Synthetic delivered result',evidence:'Synthetic accepted evidence',verdict:'accepted',createdAt:timestamp,reviewedAt:timestamp}]
  return task
})
const fixture={...seed,goals:[goal,achieved,unknown],tasks,activeTaskId:tasks[0].id}
function Harness(){
  const [mounted,setMounted]=useState(false),[number,setNumber]=useState(12345),[progress,setProgress]=useState(73)
  const [revision,setRevision]=useState(0),[surface,setSurface]=useState('shared'),[updated,setUpdated]=useState(false),[replay,setReplay]=useState(0),[known,setKnown]=useState(NaN)
  window.__numeric={mount:()=>setMounted(true),setNumber,setProgress,setKnown,rerender:()=>setRevision(value=>value+1),surface:setSurface,updateGoal:()=>setUpdated(true),fixture}
  const currentGoal=updated?{...goal,criteria:[goal.criteria[0],{...goal.criteria[1],status:'satisfied',evidence:'Synthetic newly verified evidence'}]}:goal
  const controls=<header style={{position:'sticky',top:0,zIndex:20,display:'flex',flexWrap:'wrap',gap:8,padding:12,borderBottom:'1px solid var(--border)',background:'var(--background)'}}><Button size="sm" onClick={()=>{setSurface('shared');setMounted(true);setReplay(value=>value+1)}}>Replay numbers and progress</Button><Button size="sm" variant="outline" onClick={()=>{setNumber(value=>value+10000);setProgress(value=>Math.min(100,value+20))}}>Increase targets</Button><Button size="sm" variant="outline" onClick={()=>{setNumber(value=>Math.max(0,value-8000));setProgress(value=>Math.max(0,value-20))}}>Decrease targets</Button><Button size="sm" variant="outline" onClick={()=>setSurface('dashboard')}>Dashboard</Button><Button size="sm" variant="outline" onClick={()=>setSurface('goal')}>Goal chart</Button><span style={{fontSize:11,alignSelf:'center',color:'var(--muted-foreground)'}}>Actual components · Synthetic data · System reduced motion can be toggled</span></header>
  if(surface==='dashboard')return <>{controls}<div style={{height:'calc(100vh - 57px)',display:'flex',flexDirection:'column'}}><DashboardPage state={fixture} onGoal={noop} onTask={noop} onGoals={noop} onTasks={noop} onNewTask={noop}/></div></>
  if(surface==='goal')return <>{controls}<main style={{padding:24,maxWidth:700}}><h1 style={{fontSize:14,marginBottom:20}}>Actual GoalProgress · Synthetic data</h1><GoalProgress goal={currentGoal} tasks={tasks} onTasks={noop} onCriterion={noop}/><Button id="after-chart" style={{marginTop:20}}>Next keyboard focus target</Button></main></>
  return <>{controls}<main style={{padding:24,maxWidth:680,margin:'0 auto'}} data-revision={revision}>
    <h1 style={{fontSize:14,marginBottom:20}}>Numbers, progress, and first-visible motion · Synthetic data</h1>
    <Button id="focus-control" variant="outline">Control that retains focus</Button>
    {mounted&&<div key={replay}>
      <div style={{display:'grid',gap:16,marginTop:24}}>
        <p>Integer <AnimatedNumber id="controlled-number" value={number}/></p>
        <p>Negative number <AnimatedNumber id="negative-number" value={-12.75}/></p>
        <p>Fraction <AnimatedNumber id="fraction-number" value={3.14159}/></p>
        <p>Large number <AnimatedNumber id="large-number" value={1234567890} format={value=>Math.round(value).toLocaleString('en-US')}/></p>
        <p>Retained numeric string <AnimatedNumberText id="numeric-string" value="+12.50"/></p>
        <p>Unknown <AnimatedNumber id="unknown-number" value={known}/></p>
        <p>Retained string <AnimatedNumberText id="literal-string" value="007"/></p>
        <p>Live count <AnimatedNumber id="live-number" value={number} animateUpdates={false}/></p>
        <Progress id="controlled-progress" value={progress} aria-label="Actual progress target"/>
        <div style={{position:'relative',height:28,border:'1px solid var(--border)',borderRadius:4}}><AnimatedFill id="controlled-fill" value={progress} className="bg-primary"/></div>
      </div>
      <div style={{height:'140vh'}}/>
      <section id="offscreen-region" style={{padding:20,border:'1px solid var(--border)'}}><p>First viewport entry <AnimatedNumber id="offscreen-number" value={9876}/></p><Progress id="offscreen-progress" value={64} aria-label="Actual progress in viewport"/><div style={{position:'relative',height:28,marginTop:16}}><AnimatedFill id="offscreen-fill" value={64} className="bg-primary"/></div></section>
    </div>}
  </main></>
}
createRoot(document.getElementById('root')).render(<Harness/>);
`)

const report = {
  status: 'running', base, startedAt: new Date().toISOString(),
  skill: '~/.agents/skills/apple-design/SKILL.md',
  scope: 'Actual AnimatedNumber, AnimatedNumberText, Progress, AnimatedFill, DashboardPage and GoalProgress in Chromium. Presentation frames are sampled with requestAnimationFrame; isolated synthetic fixtures, no native Runtime/model or packaged WebKit.',
  scenarios: [], errors: [],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let currentPage

async function frames(page, { numbers = [], fills = [], actions = [], duration = 1150 }) {
  return page.evaluate(async config => {
    const samples = [], changes = []
    const nodeIds = new WeakMap()
    let nextNodeId = 0
    const nodeId = node => {
      if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId)
      return nodeIds.get(node)
    }
    const begin = performance.now()
    let index = 0
    const read = () => {
      const result = { at: performance.now() - begin, numbers: {}, fills: {}, focusId: document.activeElement?.id, scrollY }
      for (const selector of config.numbers) {
        const node = document.querySelector(selector)
        if (!node) { result.numbers[selector] = null; continue }
        const visual = node.querySelector('[data-slot="animated-number-value"]')
        result.numbers[selector] = { nodeId: nodeId(node), text: visual?.textContent ?? node.textContent, accessible: node.querySelector('.animated-number-target')?.textContent, target: node.dataset.numberTarget, width: node.getBoundingClientRect().width }
      }
      for (const selector of config.fills) {
        const root = document.querySelector(selector)
        if (!root) { result.fills[selector] = null; continue }
        const node = root.matches('[data-slot="progress"]') ? root.querySelector('[data-slot="progress-indicator"]') : root.querySelector('[data-slot="animated-fill"]') ?? root
        const transform = getComputedStyle(node).transform
        const matrix = transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform)
        const percentage = root.matches('[data-slot="progress"]') ? 100 * (1 + matrix.m41 / root.getBoundingClientRect().width) : matrix.a * 100
        result.fills[selector] = { nodeId: nodeId(root), percentage, transform, target: root.getAttribute('aria-valuenow') ?? root.dataset.fillTarget, width: root.getBoundingClientRect().width }
      }
      return result
    }
    samples.push(read())
    return new Promise(resolve => {
      const tick = () => {
        const elapsed = performance.now() - begin
        while (index < config.actions.length && elapsed >= config.actions[index].at) {
          const action = config.actions[index++]
          const before = read()
          if (action.mount) window.__numeric.mount()
          if ('number' in action) window.__numeric.setNumber(action.number)
          if ('progress' in action) window.__numeric.setProgress(action.progress)
          if ('known' in action) window.__numeric.setKnown(action.known)
          if (action.rerender) window.__numeric.rerender()
          if (action.surface) window.__numeric.surface(action.surface)
          if (action.selector) document.querySelector(action.selector).click()
          if (action.scroll) document.querySelector(action.scroll).scrollIntoView({ behavior: 'instant', block: 'center' })
          changes.push({ action, before, after: read() })
        }
        samples.push(read())
        if (elapsed < config.duration) requestAnimationFrame(tick)
        else resolve({ samples, changes })
      }
      requestAnimationFrame(tick)
    })
  }, { numbers, fills, actions, duration })
}

const numeric = text => Number(text.replaceAll(',', ''))
const values = (result, kind, selector, key) => result.samples.map(sample => sample[kind][selector]?.[key]).filter(value => value !== undefined && value !== null)
function intermediate(list, start, target, tolerance = 0) {
  const low = Math.min(start, target), high = Math.max(start, target)
  return new Set(list.filter(value => value > low + tolerance && value < high - tolerance).map(value => Number(value).toFixed(5))).size
}
function assertMonotone(list, direction, label, tolerance = 0.01) {
  for (let index = 1; index < list.length; index++) {
    assert(direction === 'up' ? list[index] >= list[index - 1] - tolerance : list[index] <= list[index - 1] + tolerance, `${label}: ordinary loading must not bounce`)
  }
}
function assertLoad(result, kind, selector, target, reduced) {
  // A selector may match both the outgoing and newly mounted chart while a
  // surface changes. Only measure the final node's own appearance lifecycle.
  const finalNodeId = result.samples.at(-1)[kind][selector]?.nodeId
  const lifecycle = { ...result, samples: result.samples.filter(sample => sample[kind][selector]?.nodeId === finalNodeId) }
  const raw = values(lifecycle, kind, selector, kind === 'numbers' ? 'text' : 'percentage')
  const list = kind === 'numbers' ? raw.map(numeric) : raw
  assert(list.length > 3, `${selector}: expected presentation-frame samples`)
  assert(Math.abs(list.at(-1) - target) < 0.005, `${selector}: exact settle, got ${list.at(-1)} expected ${target}`)
  if (reduced) {
    assert(list.every(value => Math.abs(value - target) < 0.005), `${selector}: reduced motion exposes the actual target immediately`)
  } else {
    const required = kind === 'numbers' && Number.isInteger(target) ? Math.min(3, Math.max(0, Math.abs(target) - 1)) : 3
    assert(intermediate(list, 0, target, kind === 'numbers' ? 0 : 0.01) >= required, `${selector}: actual intermediate presentation frames required`)
    assertMonotone(list, target >= 0 ? 'up' : 'down', selector)
  }
  return { intermediateValues: intermediate(list, 0, target), initial: list[0], final: list.at(-1), sampledFrames: list.length }
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const theme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
    const reduced = reducedMotion === 'reduce'
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, locale: 'zh-CN', colorScheme: theme })
    const page = await context.newPage()
    currentPage = page
    page.on('pageerror', error => report.errors.push(error.message))
    await page.addInitScript(theme => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') })
    }, theme)
    const scenario = { width, height, theme, reducedMotion, checks: {} }
    const scenarioFrames = {}
    const prefix = `${output}/${width}-${theme}-${reducedMotion}`
    scenario.frameEvidence = `${prefix}-frames.json`
    report.scenarios.push(scenario)
    try {
      await page.goto(`${base}/${output}/harness.html?v=${version}`)
      await page.waitForFunction(() => typeof window.__numeric?.mount === 'function')
      assert.equal(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), false)
      await page.locator('#focus-control').focus()
      const selectors = ['#controlled-number', '#negative-number', '#fraction-number', '#large-number', '#numeric-string', '#live-number']
      const initial = await frames(page, { numbers: selectors, fills: ['#controlled-progress', '#controlled-fill'], actions: [{ at: 0, mount: true }], duration: 1700 })
      scenarioFrames.initial = initial
      scenario.checks.initial = {
        integer: assertLoad(initial, 'numbers', selectors[0], 12345, reduced),
        negative: assertLoad(initial, 'numbers', selectors[1], -12.75, reduced),
        fraction: assertLoad(initial, 'numbers', selectors[2], 3.14159, reduced),
        large: assertLoad(initial, 'numbers', selectors[3], 1234567890, reduced),
        numericString: assertLoad(initial, 'numbers', selectors[4], 12.5, reduced),
        liveEntrance: assertLoad(initial, 'numbers', selectors[5], 12345, reduced),
        progress: assertLoad(initial, 'fills', '#controlled-progress', 73, reduced),
        chartFill: assertLoad(initial, 'fills', '#controlled-fill', 73, reduced),
      }
      for (const selector of selectors) {
        const accessible = values(initial, 'numbers', selector, 'accessible')
        assert.equal(new Set(accessible).size, 1, `${selector}: accessible target must never expose transient counts`)
        const widths = values(initial, 'numbers', selector, 'width')
        assert(Math.max(...widths) - Math.min(...widths) < 0.2, `${selector}: final width is reserved throughout loading`)
      }
      assert(initial.samples.every(sample => sample.focusId === 'focus-control'), 'Numeric loading must preserve keyboard focus')
      await expect(page.locator('#unknown-number')).toHaveText('—')
      await expect(page.locator('#literal-string')).toHaveText('007')
      await expect(page.locator('#numeric-string .animated-number-target')).toHaveText('+12.50')
      await expect(page.locator('#large-number [data-slot="animated-number-value"]')).toHaveText('1,234,567,890')
      await expect(page.getByRole('progressbar', { name: 'Actual progress target' })).toHaveAttribute('aria-valuenow', '73')
      scenario.checks.accessibility = { trueTargetFromFirstFrame: true, reservedWidth: true, focusPreserved: true, unknownAndLeadingZeroRemainLiteral: true }

      const becameKnown = await frames(page, { numbers: ['#unknown-number'], actions: [{ at: 0, known: 42.5 }] })
      scenarioFrames.lateKnown = becameKnown
      // The initial unknown sample has no numeric presentation; only evaluate
      // frames after the real target replaces the unknown label.
      const finiteKnown = { ...becameKnown, samples: becameKnown.samples.filter(sample => sample.numbers['#unknown-number']?.accessible) }
      scenario.checks.lateKnown = assertLoad(finiteKnown, 'numbers', '#unknown-number', 42.5, reduced)

      const rerender = await frames(page, { numbers: ['#controlled-number'], fills: ['#controlled-progress', '#controlled-fill'], actions: [{ at: 0, rerender: true }], duration: 300 })
      scenarioFrames.rerender = rerender
      assert(values(rerender, 'numbers', '#controlled-number', 'text').every(text => numeric(text) === 12345), 'Unrelated rerenders must not replay first appearance')
      for (const selector of ['#controlled-progress', '#controlled-fill']) assert(values(rerender, 'fills', selector, 'percentage').every(value => Math.abs(value - 73) < .005), `${selector}: rerender must not replay fill`)
      scenario.checks.noReplay = true

      const offscreenBefore = await frames(page, { numbers: ['#offscreen-number'], fills: ['#offscreen-progress', '#offscreen-fill'], duration: 250 })
      scenarioFrames.offscreenBefore = offscreenBefore
      if (!reduced) {
        assert(values(offscreenBefore, 'numbers', '#offscreen-number', 'text').every(text => numeric(text) === 0), 'Offscreen number waits for its first visible appearance')
        for (const selector of ['#offscreen-progress', '#offscreen-fill']) assert(values(offscreenBefore, 'fills', selector, 'percentage').every(value => Math.abs(value) < .005), `${selector}: offscreen fill must wait`)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        const unseenReduced = await frames(page, { numbers: ['#offscreen-number'], fills: ['#offscreen-progress', '#offscreen-fill'], duration: 250 })
        scenarioFrames.unseenReduced = unseenReduced
        assert(values(unseenReduced, 'numbers', '#offscreen-number', 'text').slice(3).every(text => numeric(text) === 9876), 'An unseen value settles when reduced motion turns on')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        const unseenRestored = await frames(page, { numbers: ['#offscreen-number'], fills: ['#offscreen-progress', '#offscreen-fill'], duration: 250 })
        scenarioFrames.unseenMotionRestored = unseenRestored
        assert(values(unseenRestored, 'numbers', '#offscreen-number', 'text').slice(3).every(text => numeric(text) === 0), 'Restoring motion before first appearance re-arms the unseen count')
        for (const selector of ['#offscreen-progress', '#offscreen-fill']) assert(values(unseenRestored, 'fills', selector, 'percentage').slice(3).every(value => Math.abs(value) < .005), 'Restoring motion before first appearance re-arms unseen fills')
      }
      const entry = await frames(page, { numbers: ['#offscreen-number'], fills: ['#offscreen-progress', '#offscreen-fill'], actions: [{ at: 0, scroll: '#offscreen-region' }], duration: 1150 })
      scenarioFrames.offscreenEntry = entry
      scenario.checks.offscreen = {
        number: assertLoad(entry, 'numbers', '#offscreen-number', 9876, reduced),
        progress: assertLoad(entry, 'fills', '#offscreen-progress', 64, reduced),
        fill: assertLoad(entry, 'fills', '#offscreen-fill', 64, reduced),
      }
      const reentry = await frames(page, { numbers: ['#offscreen-number'], fills: ['#offscreen-progress'], actions: [{ at: 0, scroll: '#focus-control' }, { at: 120, scroll: '#offscreen-region' }], duration: 450 })
      scenarioFrames.offscreenReentry = reentry
      assert(values(reentry, 'numbers', '#offscreen-number', 'text').every(text => numeric(text) === 9876), 'Scrolling away and back must not replay visible number')
      assert(values(reentry, 'fills', '#offscreen-progress', 'percentage').every(value => Math.abs(value - 64) < .005), 'Scrolling away and back must not replay visible progress')
      scenario.checks.offscreen.noReentryReplay = true
      await page.locator('#focus-control').scrollIntoViewIfNeeded()
      await page.locator('#focus-control').focus()

      const retarget = await frames(page, { numbers: ['#controlled-number', '#live-number'], fills: ['#controlled-progress', '#controlled-fill'], actions: [{ at: 0, number: 30000, progress: 95 }, { at: 100, number: 5000, progress: 20 }], duration: 1450 })
      scenarioFrames.retarget = retarget
      const last = retarget.samples.at(-1)
      assert.equal(numeric(last.numbers['#controlled-number'].text), 5000)
      assert.equal(numeric(last.numbers['#live-number'].text), 5000)
      for (const selector of ['#controlled-progress', '#controlled-fill']) assert(Math.abs(last.fills[selector].percentage - 20) < .005)
      const reversal = retarget.changes[1]
      assert.equal(reversal.before.numbers['#controlled-number'].text, reversal.after.numbers['#controlled-number'].text, 'Retarget cannot synchronously jump to the previous endpoint')
      for (const selector of ['#controlled-progress', '#controlled-fill']) assert(Math.abs(reversal.before.fills[selector].percentage - reversal.after.fills[selector].percentage) < .005, 'Fill reversals cannot synchronously jump')
      if (!reduced) {
        const updateNumbers = values(retarget, 'numbers', '#controlled-number', 'text').map(numeric)
        assert(new Set(updateNumbers).size > 6, 'Interrupted numeric update must animate through real frames')
        assert(values(retarget, 'numbers', '#live-number', 'text').every(text => [12345, 30000, 5000].includes(numeric(text))), 'Streaming counter updates remain immediate after the entrance')
        const after = retarget.samples.filter(sample => sample.at > reversal.before.at && sample.at < reversal.before.at + 55)
        assert(after.some(sample => numeric(sample.numbers['#controlled-number'].text) > numeric(reversal.before.numbers['#controlled-number'].text)), 'Reversal carries forward presentation velocity before turning around')
      }
      assert(retarget.samples.every(sample => sample.focusId === 'focus-control'), 'Retargeting preserves focus')
      scenario.checks.retarget = { noSynchronousJump: true, settledIncreaseThenDecrease: true, liveCounterUpdatesImmediately: true, focusPreserved: true }

      if (!reduced) {
        const capture = frames(page, { numbers: ['#controlled-number'], fills: ['#controlled-progress', '#controlled-fill'], actions: [{ at: 0, number: 50000, progress: 88 }], duration: 700 })
        await page.waitForTimeout(90)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        const preference = await capture
        scenarioFrames.liveReducedPreference = preference
        const tail = preference.samples.filter(sample => sample.at > 250)
        assert(tail.length > 3 && tail.every(sample => numeric(sample.numbers['#controlled-number'].text) === 50000), 'Live reduced-motion preference must settle an in-flight count')
        for (const selector of ['#controlled-progress', '#controlled-fill']) assert(tail.every(sample => Math.abs(sample.fills[selector].percentage - 88) < .005), 'Live reduced-motion preference must settle in-flight fills')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        const restored = await frames(page, { numbers: ['#controlled-number'], fills: ['#controlled-progress'], duration: 250 })
        scenarioFrames.motionRestored = restored
        assert(values(restored, 'numbers', '#controlled-number', 'text').every(text => numeric(text) === 50000), 'Restoring motion cannot replay settled counters')
        scenario.checks.liveReducedPreference = { settlesInFlight: true, restoringMotionDoesNotReplay: true }
      }

      const dashboard = await frames(page, { numbers: ['.metric-active > strong [data-slot="animated-number"]'], fills: ['.metric-active [data-slot="progress"]', '.metric-complete [data-slot="progress"]', '.metric-week [data-slot="progress"]'], actions: [{ at: 0, surface: 'dashboard' }] })
      scenarioFrames.dashboard = dashboard
      scenario.checks.dashboard = {
        activeGoalCount: assertLoad(dashboard, 'numbers', '.metric-active > strong [data-slot="animated-number"]', 2, reduced),
        criteriaProgress: assertLoad(dashboard, 'fills', '.metric-active [data-slot="progress"]', 50, reduced),
        goalCompletion: assertLoad(dashboard, 'fills', '.metric-complete [data-slot="progress"]', 33, reduced),
        weeklyCompletion: assertLoad(dashboard, 'fills', '.metric-week [data-slot="progress"]', 38, reduced),
      }
      await expect(page.getByLabel('Goal without completion criteria：目标标准验收率 —')).toBeVisible()
      assert.equal(await page.getByLabel('Goal without completion criteria：进度').getByRole('progressbar').count(), 0)
      await page.screenshot({ path: `${output}/${width}-${theme}-${reducedMotion}-dashboard.png` })

      const goalCharts = await frames(page, { fills: ['.goal-progress-task-segments [data-status="done"] .animated-fill-container', '.goal-progress-criterion-segments [data-status="satisfied"] .animated-fill-container'], actions: [{ at: 0, surface: 'goal' }] })
      scenarioFrames.goalCharts = goalCharts
      for (const selector of Object.keys(goalCharts.samples.at(-1).fills)) {
        scenario.checks.goalChart ??= {}
        scenario.checks.goalChart[selector] = assertLoad(goalCharts, 'fills', selector, 100, reduced)
      }
      const criterion = page.getByRole('button', { name: 'Criterion awaiting verification：待验证', exact: true })
      const rect = await criterion.boundingBox()
      assert(rect.height >= 28 && rect.width >= 40, 'Chart controls retain minimum usable targets')
      await criterion.focus()
      await page.evaluate(() => window.__numeric.updateGoal())
      const verified = page.getByRole('button', { name: 'Criterion awaiting verification：已满足', exact: true })
      await expect(verified).toBeFocused()
      assert.deepEqual(await verified.boundingBox(), rect, 'Verification state changes retain chart control geometry')
      await verified.press('Enter')
      await expect(verified).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.locator('#after-chart')).toBeFocused()
      scenario.checks.goalChart.fixedHitAreaAndKeyboardFocus = true
      await page.screenshot({ path: `${output}/${width}-${theme}-${reducedMotion}-goal.png` })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal viewport overflow')
      scenario.checks.noHorizontalOverflow = true

      // Use the complete app with a new persisted browser fixture as a separate
      // integration layer. This does not touch a desktop workspace or Runtime.
      await page.evaluate(() => localStorage.setItem('goalward.preview.v1', JSON.stringify(window.__numeric.fixture)))
      await page.goto(base)
      await expect(page.locator('.settings-nav')).toBeVisible()
      const navigationCounts = page.locator('.primary-navigation [data-slot="animated-number"]')
      await expect(navigationCounts).toHaveCount(4)
      await expect.poll(async () => navigationCounts.locator('[data-slot="animated-number-value"]').allTextContents()).toEqual(['3', '0', '8', '0'])
      await page.locator('.primary-navigation').getByRole('button', { name: 'Dashboard', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
      await expect.poll(() => page.locator('.metric-week [data-slot="progress-indicator"]').evaluate(node => {
        const matrix=new DOMMatrixReadOnly(getComputedStyle(node).transform)
        return Math.round(100*(1+matrix.m41/node.parentElement.getBoundingClientRect().width))
      })).toBe(38)
      await page.screenshot({ path: `${prefix}-app-dashboard.png` })
      const registeredSelector = '[aria-label="运行时列表"] [data-slot="animated-number"][data-number-target="6"]'
      const enabledSelector = '[aria-label="运行时列表"] [data-slot="animated-number"][data-number-target="3"]'
      const runtimeSettings = await frames(page, { numbers: [registeredSelector, enabledSelector], actions: [{ at: 0, selector: '.settings-nav' }] })
      scenarioFrames.appRuntimeSettings = runtimeSettings
      scenario.checks.actualApp = { navigationCounts: [3, 0, 8, 0], registered: assertLoad(runtimeSettings, 'numbers', registeredSelector, 6, reduced), enabled: assertLoad(runtimeSettings, 'numbers', enabledSelector, 3, reduced), nativeRuntimeStarted: false }
      const settingsCategories = page.getByRole('navigation', { name: '设置分类', exact: true })
      await settingsCategories.getByRole('button', { name: '模型与供应商', exact: true }).click()
      await expect(page.getByRole('tab', { name: '模型目录 0' })).toBeVisible()
      await expect(page.getByRole('tab', { name: '供应商连接 0' })).toBeVisible()
      await settingsCategories.getByRole('button', { name: '应用更新', exact: true }).click()
      await expect(page.getByRole('region', { name: '应用更新', exact: true })).toBeVisible()
      await expect(page.getByRole('region', { name: '应用更新', exact: true })).toContainText('浏览器提供界面预览')
      await page.screenshot({ path: `${prefix}-app-settings.png` })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'Actual app/settings fit the desktop viewport')
      scenario.checks.actualApp.settingsModelTabsAndUpdateSurface = true
      await page.getByRole('button', { name: '返回工作台', exact: true }).click()
      await page.locator('.primary-navigation').getByRole('button', { name: /^目标/ }).click()
      await page.getByRole('button', { name: '打开目标：Number and chart motion verification', exact: true }).click()
      const metric = page.locator('.goal-metric strong')
      await metric.scrollIntoViewIfNeeded()
      await expect(metric.locator('[data-slot="animated-number-value"]')).toHaveText('42.75')
      const metricLayout = await metric.evaluate(node => ({ height: node.getBoundingClientRect().height, numberDisplay: getComputedStyle(node.querySelector('[data-slot="animated-number"]')).display, text: node.innerText }))
      assert(metricLayout.height < 26, 'Goal metric stays one compact inline number and unit')
      assert.equal(metricLayout.numberDisplay, 'inline-grid')
      await page.screenshot({ path: `${prefix}-app-goal-metric.png` })
      scenario.checks.actualApp.goalMetric = metricLayout
      console.log(`Passed ${width} × ${height}, ${theme}, ${reducedMotion}`)
    } finally {
      await writeFile(`${prefix}-frames.json`, JSON.stringify(scenarioFrames, null, 2))
      await context.close()
    }
  }
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.length, errors: report.errors, report: `${output}/report.json` }, null, 2))
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  await currentPage?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
