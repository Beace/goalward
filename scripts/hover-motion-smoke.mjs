import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

// Uses the real application, including its built CSS. Fixture construction is
// local, so BASE_URL may point to either Vite dev or `vite preview`.
// Run: BASE_URL=http://127.0.0.1:1437 node scripts/hover-motion-smoke.mjs
const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:1420'
const output = 'test-results/hover-motion'
await mkdir(output, { recursive: true })
const fixtureServer = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
let fixture
try {
  const { createInitialState, createTask, applyRuntimeEvent } = await fixtureServer.ssrLoadModule('/src/lib/domain.ts')
  const { createGoal } = await fixtureServer.ssrLoadModule('/src/lib/goals.ts')
  const { createAgentProfile } = await fixtureServer.ssrLoadModule('/src/lib/agent-profiles.ts')
  fixture = createInitialState()
  fixture.settings.defaultDirectory = '/tmp/hover-motion-fixture'
  fixture.settings.models = [{ id: 'hover-model', name: 'Hover fixture model', modelId: 'hover-model', enabled: true, runtimeIds: ['codex', 'claude'] }]
  const goal = createGoal({ title: 'Hover 动效验收目标', expected: '交互反馈保持连续', currentSummary: '独立浏览器合成数据；没有启动真实 Agent。', criteria: ['按钮与 Tab 的现有颜色变化连续'] })
  const agent = createAgentProfile(fixture.settings, { name: 'Hover 验收 Agent', role: '界面验收', assignedGoalIds: [goal.id] })
  const task = createTask(fixture.settings, 'Hover 动效验收任务', fixture.settings.defaultDirectory, 'solo')
  task.goalId = goal.id
  const runtime = fixture.settings.runtimes.find(item => item.adapter === 'claude')
  task.members[0].runtimeId = runtime.id
  const member = task.members[0]
  task.runs = [{ id: 'hover-run', createdAt: task.createdAt, directory: task.directory, prompt: 'Synthetic hover fixture', members: [{ ...member, runtime, model: '', status: 'running' }] }]
  fixture = { ...fixture, tasks: [task], activeTaskId: task.id, goals: [goal], agents: [agent], activeGoalId: goal.id, onboarding: { version: 1, completedAt: task.createdAt, outcome: 'configured' } }
  let sequence = 0
  const event = (payload, kind = 'stdout') => ({ id: `hover-event-${++sequence}`, taskId: task.id, runId: 'hover-run', memberId: member.id, timestamp: new Date(Date.parse(task.createdAt) + sequence * 10).toISOString(), kind, text: payload ? `${JSON.stringify(payload)}\n` : '' })
  const stream = payload => event({ type: 'stream_event', event: payload, session_id: 'hover-session', parent_tool_use_id: null })
  const events = [
    stream({ type: 'message_start', message: { id: 'hover-message', role: 'assistant', content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '这是合成的思考过程，用于验收原生 disclosure 按钮的 hover。' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '这是浏览器 hover 动效验收合成回复。' } }),
    stream({ type: 'content_block_stop', index: 1 }),
    stream({ type: 'message_stop' }),
    event({ type: 'assistant', message: { id: 'hover-message', content: [{ type: 'thinking', thinking: '这是合成的思考过程，用于验收原生 disclosure 按钮的 hover。' }, { type: 'text', text: '这是浏览器 hover 动效验收合成回复。' }] }, session_id: 'hover-session' }),
    event({ type: 'result', subtype: 'success', result: '这是浏览器 hover 动效验收合成回复。', session_id: 'hover-session' }),
    event(null, 'completed'),
  ]
  fixture = events.reduce(applyRuntimeEvent, fixture)
} finally { await fixtureServer.close() }
await writeFile(`${output}/fixture.json`, `${JSON.stringify(fixture, null, 2)}\n`)

const report = { status: 'running', startedAt: new Date().toISOString(), baseUrl, scope: 'Production application in isolated Chrome contexts with synthetic persisted state; real mouse input and controlled browser CSSTransition presentation samples. No native Runtime or real user storage.', scenarios: [], errors: [] }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let activePage

function delta(a, b) { return Math.max(...a.map((value, index) => Math.abs(value - b[index]))) }
function checkGeometry(a, b, label) {
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(a.rect[key] - b.rect[key]) < 0.5, `${label}: hover changed layout ${key}`)
  assert.equal(a.transform, b.transform, `${label}: hover added a transform`)
}

async function installCapture(page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data) }
    window.__hoverRead = node => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return { background: rgba(style.backgroundColor), color: rgba(style.color), border: rgba(style.borderBottomColor), opacity: Number(style.opacity), transform: style.transform, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, duration: style.transitionDuration, properties: style.transitionProperty, hover: node.matches(':hover'), focusVisible: node.matches(':focus-visible'), active: node.matches(':active'), hoverInput: node.closest('[data-hover-input]')?.getAttribute('data-hover-input') }
    }
    window.__hoverArm = (node, enter) => {
      window.__hoverCapture?.dispose?.()
      const state = window.__hoverCapture = { node, done: false, animations: [], before: window.__hoverRead(node), enter }
      const events = enter ? ['pointerenter', 'pointermove'] : ['pointerleave']
      let capturing = false
      const handler = () => {
        if (capturing) return
        capturing = true
        let frames = 0
        const capture = () => {
          getComputedStyle(node).backgroundColor // Flush the actual hover rule and CSS transition creation.
          const animations = node.getAnimations().filter(animation => animation instanceof CSSTransition && animation.playState !== 'idle' && ['background-color', 'color', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color', 'opacity'].includes(animation.transitionProperty))
          if (!animations.length && ++frames < 4) { requestAnimationFrame(capture); return }
          state.animations = animations
          animations.forEach(animation => { animation.pause(); animation.currentTime = 0 })
          state.after = window.__hoverRead(node)
          state.done = true
          state.dispose()
        }
        // Radix updates highlight/focus from its pointermove handler. Sample
        // after the event has completed, so an outgoing transition cannot be
        // mistaken for the new transition and then cancelled by React.
        requestAnimationFrame(capture)
      }
      state.dispose = () => events.forEach(event => node.removeEventListener(event, handler))
      events.forEach(event => node.addEventListener(event, handler))
    }
    window.__hoverSample = fraction => {
      const state = window.__hoverCapture
      state.animations.forEach(animation => { animation.currentTime = Number(animation.effect.getComputedTiming().duration) * fraction })
      return window.__hoverRead(state.node)
    }
  })
}

async function moveOutside(page) {
  const viewport = page.viewportSize()
  await page.mouse.move(viewport.width - 2, viewport.height - 2)
}
async function armAndMove(page, locator, enter) {
  await locator.evaluate((node, enter) => window.__hoverArm(node, enter), enter)
  if (enter) {
    const box = await locator.boundingBox()
    assert(box, 'Hover control must have a visible hit area')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  } else await moveOutside(page)
  await page.waitForFunction(() => window.__hoverCapture.done)
  return page.evaluate(() => ({ before: window.__hoverCapture.before, after: window.__hoverCapture.after, transitions: window.__hoverCapture.animations.map(animation => ({ property: animation.transitionProperty, duration: Number(animation.effect.getComputedTiming().duration), playState: animation.playState })) }))
}
async function samples(page) {
  return page.evaluate(() => [0, 0.25, 0.5, 0.75, 1].map(fraction => ({ fraction, ...window.__hoverSample(fraction) })))
}
async function finish(page) {
  await page.evaluate(() => window.__hoverCapture?.animations.forEach(animation => animation.finish()))
}

async function hoverCheck(page, locator, label, { required = true, property = 'background' } = {}) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  await moveOutside(page)
  await locator.evaluate(node => { if (document.activeElement === node) node.blur(); node.getAnimations().filter(animation => animation instanceof CSSTransition).forEach(animation => animation.finish()) })
  const enter = await armAndMove(page, locator, true)
  const incoming = await samples(page)
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const first = enter.before, last = incoming.at(-1)
  const changed = delta(first[property], last[property]) > 0
  report.lastCheck = { label, enter, incoming }
  if (required) assert(changed, `${label}: fixture expected a real ${property} hover change: ${JSON.stringify(enter)}`)
  for (const sample of incoming) checkGeometry(first, sample, label)
  for (const animation of enter.transitions) assert(animation.duration > 0 && animation.duration <= 121, `${label}: unexpected duration ${animation.duration}ms`)
  if (reduced) assert.equal(enter.transitions.length, 0, `${label}: reduced motion must settle hover immediately`)
  else if (changed) {
    assert(enter.transitions.length, `${label}: changed hover colors must have actual CSS transitions`)
    assert(incoming.slice(1, -1).some(sample => delta(sample[property], first[property]) > 0 && delta(sample[property], last[property]) > 0), `${label}: missing an actual intermediate ${property} presentation value`)
  }
  // Interrupt at a deterministic presentation value, then drive real mouse-out.
  // CSS is allowed to shorten reversal timing, but it must preserve this value.
  const midpoint = await page.evaluate(() => window.__hoverSample(0.42))
  const leave = await armAndMove(page, locator, false)
  const outgoing = await samples(page)
  if (!reduced) for (const key of ['background', 'color', 'border']) assert(delta(midpoint[key], leave.after[key]) <= 2, `${label}: reversal snapped ${key}`)
  checkGeometry(midpoint, leave.after, label)
  if (changed) assert(delta(outgoing.at(-1)[property], first[property]) <= 2, `${label}: mouse-out failed to return to rest`)
  // Multiple real pointer reversals while the presented value is between ends.
  const rapid = []
  for (const entering of [true, false, true, false]) {
    const before = await page.evaluate(() => window.__hoverSample(0.32))
    const result = await armAndMove(page, locator, entering)
    report.lastSeam = { label, before, ...result }
    if (!reduced) for (const key of ['background', 'color', 'border']) assert(delta(before[key], result.after[key]) <= 2, `${label}: rapid retarget snapped ${key}`)
    else assert.equal(result.transitions.length, 0, `${label}: reduced rapid retarget must remain static`)
    rapid.push({ enter: entering, before, after: result.after, transitions: result.transitions })
  }
  await finish(page)
  return { label, property, changed, enter, incoming, leave, outgoing, rapid }
}

async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - innerWidth, vertical: document.documentElement.scrollHeight - innerHeight }))
  assert(dimensions.horizontal <= 1 && dimensions.vertical <= 1, `Viewport overflow: ${JSON.stringify(dimensions)}`)
  return dimensions
}
async function instantChecks(page, locator, disabled) {
  await moveOutside(page)
  await locator.focus()
  await page.keyboard.press('Tab') // Establish keyboard modality, then focus the chosen control.
  await locator.focus()
  const focus = await locator.evaluate(node => window.__hoverRead(node))
  assert(focus.focusVisible, 'Keyboard focus must use the focus-visible path')
  assert(focus.duration.split(',').every(value => parseFloat(value) === 0), 'Keyboard focus must cancel delayed hover feedback')
  await locator.evaluate(node => node.blur())
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const pressed = await locator.evaluate(node => ({ ...window.__hoverRead(node), colorTransitions: node.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.transitionProperty) }))
  assert(pressed.active && pressed.duration.split(',').every(value => parseFloat(value) === 0), 'Press feedback must be immediate')
  assert.equal(pressed.colorTransitions.length, 0, 'Press must stop in-flight hover transitions')
  await page.mouse.up()
  await expect(disabled).toBeDisabled()
  await moveOutside(page)
  const disabledBefore = await disabled.evaluate(node => window.__hoverRead(node))
  const disabledBox = await disabled.boundingBox()
  await page.mouse.move(disabledBox.x + disabledBox.width / 2, disabledBox.y + disabledBox.height / 2)
  const disabledAfter = await disabled.evaluate(node => ({ ...window.__hoverRead(node), transitions: node.getAnimations().filter(animation => animation instanceof CSSTransition).length }))
  assert.equal(disabledAfter.transitions, 0, 'Disabled control must not animate hover')
  assert(delta(disabledBefore.background, disabledAfter.background) === 0 && delta(disabledBefore.color, disabledAfter.color) === 0, 'Disabled control must not react to pointer hover')
  return { keyboardFocus: focus, pressed, disabledBefore, disabledAfter }
}
async function keyboardTabs(page, list) {
  const tabs = list.getByRole('tab')
  const first = tabs.first(), second = tabs.nth(1)
  await first.click()
  await page.keyboard.press('Tab')
  await first.focus()
  await list.evaluate(node => {
    window.__hoverKeyboard = { start: null, changed: null }
    node.addEventListener('keydown', () => { window.__hoverKeyboard.start = performance.now() }, { once: true, capture: true })
    const observer = new MutationObserver(() => {
      if (node.querySelectorAll('[data-state=active]')[0] !== node.querySelector('[role=tab]') && window.__hoverKeyboard.start !== null) { window.__hoverKeyboard.changed = performance.now(); observer.disconnect() }
    })
    observer.observe(node, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
  })
  await page.keyboard.press('ArrowRight')
  await expect(second).toHaveAttribute('data-state', 'active')
  await expect(second).toBeFocused()
  const result = await second.evaluate(node => ({ ...window.__hoverRead(node), elapsed: window.__hoverKeyboard.changed - window.__hoverKeyboard.start, underlineDuration: getComputedStyle(node, '::after').transitionDuration }))
  result.previous = await first.evaluate(node => ({ ...window.__hoverRead(node), transitions: node.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.transitionProperty) }))
  report.lastKeyboardTabs = result
  assert(result.focusVisible && result.duration.split(',').every(value => parseFloat(value) === 0), 'Keyboard Tab selection must stay immediate')
  assert(result.elapsed >= 0 && result.elapsed < 100, `Keyboard selection delayed by ${result.elapsed}ms`)
  assert(result.underlineDuration.split(',').every(value => parseFloat(value) === 0), 'Tab underline must not acquire a hover transition')
  const previousDurations = result.previous.duration.split(',').map(value => parseFloat(value))
  assert(previousDurations[0] === 0 && previousDurations.slice(2).every(value => value === 0) && result.previous.transitions.length === 0, 'Previous keyboard Tab must clear its selection immediately; unchanged hovered text may retain a color transition declaration')
  return result
}
async function modeKeyboardToPointer(page) {
  const group = page.locator('.mode-switch')
  const solo = group.getByRole('button', { name: '单 Agent', exact: true })
  const team = group.getByRole('button', { name: '协作', exact: true })
  await moveOutside(page)
  await team.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(solo).toBeFocused()
  assert(await solo.evaluate(node => node.matches(':focus-visible')), 'Mode focus must begin in keyboard modality')
  const selectedBefore = await group.evaluate(node => Array.from(node.querySelectorAll('button')).map(button => button.getAttribute('aria-pressed')))
  const check = await hoverCheck(page, team, 'Mode button immediately after keyboard')
  const selectedAfter = await group.evaluate(node => Array.from(node.querySelectorAll('button')).map(button => button.getAttribute('aria-pressed')))
  assert.deepEqual(selectedAfter, selectedBefore, 'Mode hover must not activate a business change')
  return check
}
async function keyboardMenu(page) {
  const list = page.getByRole('listbox')
  await list.evaluate(node => {
    window.__hoverPreviousOption = document.activeElement
    window.__hoverMenuKeyStart = window.__hoverMenuKeyChanged = null
    node.addEventListener('keydown', () => { window.__hoverMenuKeyStart = performance.now() }, { once: true, capture: true })
    node.addEventListener('focusin', () => { window.__hoverMenuKeyChanged = performance.now() }, { once: true, capture: true })
  })
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => list.evaluate(() => document.activeElement !== window.__hoverPreviousOption)).toBe(true)
  const result = await list.evaluate(() => {
    const current = document.activeElement, previous = window.__hoverPreviousOption
    const read = node => ({ ...window.__hoverRead(node), text: node.textContent, transitions: node.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.transitionProperty) })
    return { previous: read(previous), current: read(current), elapsed: window.__hoverMenuKeyChanged - window.__hoverMenuKeyStart }
  })
  report.lastKeyboardMenu = result
  assert.notEqual(result.previous.text, result.current.text, 'Menu ArrowDown must change the focused item')
  assert(result.current.focusVisible, 'Menu keyboard input must show focus')
  assert(result.elapsed >= 0 && result.elapsed < 100, `Menu keyboard selection delayed by ${result.elapsed}ms`)
  for (const item of [result.previous, result.current]) assert(item.transitions.length === 0 && item.duration.split(',').every(value => parseFloat(value) === 0), 'Menu keyboard focus must update previous/current item immediately')
  return result
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
    const page = await context.newPage()
    activePage = page
    page.on('pageerror', error => report.errors.push(error.message))
    await context.addInitScript(state => localStorage.setItem('goalward.preview.v1', JSON.stringify(state)), fixture)
    const scenario = { viewport: { width, height }, reducedMotion, checks: [], overflow: {} }
    report.scenarios.push(scenario)
    try {
      await page.goto(baseUrl)
      await expect(page.locator('.settings-nav')).toBeVisible()
      assert.equal(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), false, 'Must remain isolated browser storage')
      assert(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), 'Chrome must expose a real fine-hover pointer')
      await installCapture(page)
      await page.locator('.task-nav-item').filter({ hasText: fixture.tasks[0].title }).click()
      await expect(page.locator('.workbench')).toBeVisible()
      scenario.checks.push(await hoverCheck(page, page.locator('.settings-nav'), 'Workspace navigation button'))
      scenario.checks.push(await hoverCheck(page, page.getByRole('button', { name: '打开执行检查器', exact: true }), 'Workbench icon button'))
      scenario.checks.push(await hoverCheck(page, page.locator('.work-tab-bar').getByRole('tab', { name: '成员会话', exact: true }), 'Workbench Tab', { required: false, property: 'color' }))
      scenario.checks.push(await hoverCheck(page, page.locator('.reasoning-trigger').first(), 'Native reasoning disclosure'))
      scenario.instant = await instantChecks(page, page.locator('.task-nav-item').filter({ hasText: fixture.tasks[0].title }), page.getByRole('button', { name: '发送指令', exact: true }))
      scenario.checks.push(await modeKeyboardToPointer(page))
      const inspector = page.getByRole('button', { name: '打开执行检查器', exact: true })
      if (await inspector.getAttribute('aria-expanded') !== 'true') await inspector.click()
      await expect(page.locator('.trace-trigger').first()).toBeVisible()
      scenario.checks.push(await hoverCheck(page, page.locator('.trace-trigger').first(), 'Native trace disclosure'))
      scenario.overflow.workbench = await noOverflow(page)
      await page.screenshot({ path: `${output}/workbench-${width}-${reducedMotion}.png` })
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible()
      scenario.checks.push(await hoverCheck(page, page.getByRole('button', { name: '执行默认值', exact: true }), 'Settings category button'))
      scenario.checks.push(await hoverCheck(page, page.locator('#runtime-adapter'), 'Settings selector', { required: false }))
      await page.getByRole('button', { name: '模型与供应商', exact: true }).click()
      scenario.checks.push(await hoverCheck(page, page.getByRole('tab', { name: /供应商连接/ }), 'Settings Tab', { required: false, property: 'color' }))
      const filter = page.getByRole('combobox', { name: '按 Runtime 筛选模型', exact: true })
      await filter.click()
      scenario.keyboardSelector = await keyboardMenu(page)
      const option = page.getByRole('option', { name: 'Claude Code', exact: true })
      // Move directly from keyboard selection to pointer input. No intermediate
      // click may hide a stale focus-visible/input-mode boundary.
      scenario.checks.push(await hoverCheck(page, option, 'Selector menu item after keyboard'))
      await page.keyboard.press('Escape')
      await expect(filter).toBeFocused()
      scenario.selectorEscapeRestoresFocus = true
      scenario.keyboardSettingsTabs = await keyboardTabs(page, page.locator('[data-slot=tabs-list]'))
      scenario.checks.push(await hoverCheck(page, page.getByRole('tab', { name: /模型目录/ }), 'Settings Tab immediately after keyboard', { property: 'color' }))
      scenario.overflow.settings = await noOverflow(page)
      await page.screenshot({ path: `${output}/settings-${width}-${reducedMotion}.png` })
      await page.getByRole('button', { name: '返回工作台', exact: true }).click()
      await page.locator('.primary-navigation').getByRole('button', { name: /Agents/ }).click()
      await expect(page.locator('.agents-detail')).toBeVisible()
      scenario.checks.push(await hoverCheck(page, page.getByRole('button', { name: '复制', exact: true }), 'Agent action button'))
      scenario.checks.push(await hoverCheck(page, page.locator('.agents-tab-bar').getByRole('tab', { name: /参与目标/ }), 'Agent Tab', { required: false, property: 'color' }))
      scenario.keyboardAgentTabs = await keyboardTabs(page, page.locator('.agents-tab-bar [data-slot=tabs-list]'))
      scenario.overflow.agents = await noOverflow(page)
      await page.screenshot({ path: `${output}/agents-${width}-${reducedMotion}.png` })
      await page.locator('.primary-navigation').getByRole('button', { name: /^目标/ }).click()
      await expect(page.locator('.goal-tabs')).toBeVisible()
      scenario.checks.push(await hoverCheck(page, page.getByRole('button', { name: '记录复盘', exact: true }).first(), 'Goal action button'))
      scenario.checks.push(await hoverCheck(page, page.locator('.goal-tabs').getByRole('tab', { name: '进展记录', exact: true }), 'Goal Tab', { required: false, property: 'color' }))
      scenario.keyboardGoalTabs = await keyboardTabs(page, page.locator('.goal-tabs > [data-slot=tabs-list]'))
      scenario.overflow.goals = await noOverflow(page)
      await page.screenshot({ path: `${output}/goals-${width}-${reducedMotion}.png` })
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${width}-${reducedMotion}.png` }).catch(() => {})
      throw error
    } finally { await context.close() }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.status = 'passed'
  console.log(`PASS: ${report.scenarios.length} viewport/motion combinations, ${report.scenarios.reduce((total, scenario) => total + scenario.checks.length, 0)} real hover controls; intermediate colors, enter/leave reversal, rapid pointer retargeting, immediate keyboard/press, disabled, focus restoration and no overflow. ${output}/report.json`)
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
}
