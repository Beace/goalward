import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Browser-only fixtures. A fresh context never loads a native Tauri bridge or
// touches the application's real task/configuration files.
const outputDirectory = 'test-results/inspector-motion'
const baseUrl = process.env.INSPECTOR_SMOKE_URL ?? 'http://127.0.0.1:1420'
const timestamp = '2026-09-16T08:00:00.000Z'
const runtime = { id: 'codex', name: 'Codex', executable: 'codex', adapter: 'codex', enabled: true, args: [], defaultModel: '', description: 'Browser motion fixture' }
const member = { id: 'motion-member', name: '执行', role: '实现', runtimeId: 'codex', modelId: '' }
function fixtureTask(id, title) {
  const runId = `${id}-run`
  return {
    id, title, directory: '/tmp/inspector-motion-fixture', mode: 'solo', members: [member], createdAt: timestamp,
    messages: [{ id: `${id}-message`, role: 'assistant', text: '独立浏览器动效验收数据；没有执行真实 Agent。', createdAt: timestamp }],
    runs: [{ id: runId, createdAt: timestamp, prompt: 'Browser fixture', directory: '/tmp/inspector-motion-fixture', members: [{ ...member, runtime, model: '', status: 'completed' }] }],
    events: Array.from({ length: 80 }, (_, index) => ({ id: `${id}-event-${index}`, taskId: id, runId, memberId: member.id, timestamp, kind: 'stdout', text: `${JSON.stringify({ type: 'error', message: `${title}：测试事件 ${index + 1}` })}\n` })),
  }
}
const fixture = {
  version: 1,
  settings: { runtimes: [runtime], models: [], providers: [], defaultRuntime: 'codex', defaultMode: 'solo', maxParallel: 3, defaultDirectory: '/tmp', outputLimit: 100000 },
  tasks: [fixtureTask('motion-a', '检查器动效验收 A'), fixtureTask('motion-b', '检查器动效验收 B')],
  activeTaskId: 'motion-a',
  onboarding: { version: 1, completedAt: timestamp, outcome: 'configured' },
}
const report = {
  baseUrl, startedAt: new Date().toISOString(), status: 'running',
  skill: '~/.agents/skills/apple-design/SKILL.md',
  scope: 'Fresh browser contexts with synthetic persisted trace fixtures; no native storage or real Agent streaming.',
  scenarios: [], errors: [],
}
await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })

// Record actual RAF presentation values. Timed clicks retarget an animation
// while it is moving, without Playwright's stability waiting hiding that seam.
async function frames(page, { duration = 800, actions = [] } = {}) {
  return page.evaluate(({ duration, actions }) => new Promise(resolve => {
    const samples = []
    const clicks = []
    let started
    let actionIndex = 0
    const read = time => {
      const node = document.querySelector('#execution-inspector')
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
      return { time, x: matrix.m41, left: rect.left, right: rect.right, width: rect.width, opacity: Number(style.opacity), visibility: style.visibility, expanded: document.querySelector('[data-inspector-toggle]').getAttribute('aria-expanded') }
    }
    function tick(now) {
      started ??= now
      const time = now - started
      samples.push(read(time))
      while (actionIndex < actions.length && time >= actions[actionIndex].at) {
        const action = actions[actionIndex++]
        const trigger = document.querySelector('[data-inspector-toggle]')
        const before = read(time)
        if (trigger.getAttribute('aria-expanded') !== String(action.open)) trigger.click()
        clicks.push({ ...action, time, before, after: read(time) })
      }
      if (time < duration) requestAnimationFrame(tick)
      else resolve({ samples, clicks })
    }
    requestAnimationFrame(tick)
  }), { duration, actions })
}

function intermediate(samples) {
  return samples.filter(sample => sample.x > 2 && sample.x < sample.width - 2)
}

function checkContinuous(trace) {
  const seams = trace.clicks.slice(1).map(click => {
    const next = trace.samples.find(sample => sample.time > click.time)
    const previous = trace.samples.filter(sample => sample.time < click.time).at(-1)
    assert(next && previous, 'Every reversal must have surrounding RAF frames')
    const previousVelocity = (click.before.left - previous.left) / Math.max(1, click.time - previous.time)
    const delta = Math.abs(next.left - click.before.left)
    const limit = Math.abs(previousVelocity) * (next.time - click.time) + click.before.width * 0.12 + 6
    assert(delta < limit, `Reversal jumped ${delta.toFixed(2)}px; bound ${limit.toFixed(2)}px`)
    assert(Math.abs(click.after.left - click.before.left) < 1, 'Retarget must not synchronously snap the presented position')
    return { time: click.time, delta, limit, previousVelocity }
  })
  assert(seams.length >= 3, 'Exercise repeated reversals, not a single endpoint toggle')
  return seams
}

async function setOpen(page, open) {
  const trigger = page.locator('[data-inspector-toggle]')
  if (await trigger.getAttribute('aria-expanded') !== String(open)) await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', String(open))
  await frames(page, { duration: 650 })
  if (open) await expect.poll(() => page.locator('#execution-inspector').evaluate(node => Math.abs(new DOMMatrixReadOnly(getComputedStyle(node).transform === 'none' ? undefined : getComputedStyle(node).transform).m41))).toBeLessThan(0.5)
}

async function assertNoOverflow(page) {
  const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - innerWidth, vertical: document.documentElement.scrollHeight - innerHeight }))
  assert(overflow.horizontal <= 1 && overflow.vertical <= 1, `Viewport overflow: ${JSON.stringify(overflow)}`)
  return overflow
}

async function geometry(page) {
  return page.evaluate(() => {
    const surface = document.querySelector('#execution-inspector').getBoundingClientRect()
    const spacer = document.querySelector('#inspector-space').getBoundingClientRect()
    return { surfaceLeft: surface.left, surfaceWidth: surface.width, spacerLeft: spacer.left, spacerWidth: spacer.width, phase: document.querySelector('.main-panes').dataset.inspectorMotion, active: document.querySelector('#inspector-resize').dataset.separator, expanded: document.querySelector('[data-inspector-toggle]').getAttribute('aria-expanded') }
  })
}

async function grabClosingAtHitArea(page) {
  await setOpen(page, true)
  // Keep a real browser pointer active so the primitive can legitimately use
  // setPointerCapture. The timed event below supplies a precise moving hit point.
  await page.evaluate(() => window.addEventListener('pointerdown', event => { window.__boundaryPointer = event.pointerId }, { once: true, capture: true }))
  await page.mouse.move(600, 52)
  await page.mouse.down()
  const hit = await page.evaluate(() => new Promise((resolve, reject) => {
    const started = performance.now()
    const sampled = []
    document.querySelector('[data-inspector-toggle]').click()
    function attempt() {
      const handle = document.querySelector('#inspector-resize')
      const rect = handle.getBoundingClientRect()
      const spacer = document.querySelector('#inspector-space').getBoundingClientRect()
      sampled.push({ width: spacer.width, phase: document.querySelector('.main-panes').dataset.inspectorMotion, expanded: document.querySelector('[data-inspector-toggle]').getAttribute('aria-expanded') })
      if (spacer.width > 40 && spacer.width < 300) {
        const clientX = rect.right + 4
        const clientY = rect.top + 120
        const target = document.elementFromPoint(clientX, clientY)
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: window.__boundaryPointer, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX, clientY }))
        requestAnimationFrame(() => resolve({ clientX, clientY, offsetFromLine: 4, lineRight: rect.right, widthAtGrab: spacer.width, eventTarget: target.tagName, input: 'RAF-timed synthetic pointerdown backed by an active browser mouse pointer' }))
      } else if (performance.now() - started > 1200) reject(new Error(`Did not encounter a moving closing separator: ${JSON.stringify(sampled.filter((_, index) => index % 8 === 0))}`))
      else requestAnimationFrame(attempt)
    }
    requestAnimationFrame(attempt)
  }))
  await expect(page.locator('.main-panes')).toHaveAttribute('data-inspector-motion', 'dragging')
  await expect(page.locator('#inspector-resize')).toHaveAttribute('data-separator', 'active')
  return hit
}

async function moveFixturePointer(page, point, deltaX) {
  await page.evaluate(({ point, deltaX }) => document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: window.__boundaryPointer, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 1, clientX: point.clientX + deltaX, clientY: point.clientY, movementX: deltaX })), { point, deltaX })
  await frames(page, { duration: 25 })
  return geometry(page)
}

async function releaseFixturePointer(page, point, deltaX) {
  await page.evaluate(({ point, deltaX }) => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: window.__boundaryPointer, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: point.clientX + deltaX, clientY: point.clientY })), { point, deltaX })
  await page.mouse.move(600, 300)
  await page.mouse.up()
  await frames(page, { duration: 650 })
}

async function boundaryChecks(page, width, height) {
  const results = {}
  let hit = await grabClosingAtHitArea(page)
  const grasp = await geometry(page)
  const enlargeDelta = grasp.spacerWidth - 330
  const enlarged = await moveFixturePointer(page, hit, enlargeDelta)
  assert(Math.abs(enlarged.surfaceLeft - enlarged.spacerLeft) < 2, 'Closing grab: surface and reserved space have different left edges')
  assert(Math.abs(enlarged.surfaceWidth - enlarged.spacerWidth) < 2, 'Closing grab: surface and reserved space have different widths')
  await releaseFixturePointer(page, hit, enlargeDelta)
  const released = await geometry(page)
  assert(released.expanded === 'true' && released.spacerWidth >= 279 && released.spacerWidth <= 481, 'Released closing grab must settle at a legal open width')
  assert.equal(released.phase, 'idle', 'Settled interrupted close retained stale animating/changing state')
  results.closingHitArea = { hit, grasp, enlarged, released }

  // The settled render must restore minSize as well as the visible phase. A
  // stale changing flag can leave minSize=0 after an otherwise correct release.
  const guardHandle = await page.locator('#inspector-resize').boundingBox()
  await page.mouse.move(guardHandle.x + guardHandle.width / 2, guardHandle.y + 120)
  await page.mouse.down()
  await page.mouse.move(guardHandle.x + guardHandle.width / 2 + 180, guardHandle.y + 120)
  await frames(page, { duration: 25 })
  const clamped = await geometry(page)
  assert(clamped.spacerWidth >= 279, `Ordinary resize bypassed restored 280px minimum: ${clamped.spacerWidth}`)
  await page.mouse.up()
  const restoreHandle = await page.locator('#inspector-resize').boundingBox()
  await page.mouse.move(restoreHandle.x + restoreHandle.width / 2, restoreHandle.y + 120)
  await page.mouse.down()
  await page.mouse.move(restoreHandle.x + restoreHandle.width / 2 - (released.surfaceWidth - clamped.surfaceWidth), restoreHandle.y + 120)
  await page.mouse.up()
  await frames(page, { duration: 25 })
  const restored = await geometry(page)
  assert(Math.abs(restored.surfaceWidth - released.surfaceWidth) < 2, 'Minimum-width check failed to restore the original width')
  results.restoredMinimum = { attemptedShrink: 180, clamped, restored }

  // Do not send a real mouse-up until after confirming pointercancel released
  // the primitive. Further moves keep buttons=1 and must still leave size fixed.
  const separator = page.locator('#inspector-resize')
  const box = await separator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 120)
  await page.mouse.down()
  await page.mouse.move(box.x - 20, box.y + 120)
  await separator.evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.__boundaryPointer, pointerType: 'mouse', isPrimary: true })))
  const cancel = await geometry(page)
  await page.mouse.move(box.x - 100, box.y + 120)
  await frames(page, { duration: 40 })
  const afterHeldMove = await geometry(page)
  assert(Math.abs(cancel.spacerWidth - afterHeldMove.spacerWidth) < 1, 'pointercancel left a live resize gesture before mouse-up')
  assert.notEqual(afterHeldMove.active, 'active', 'pointercancel left separator active')
  const cursor = await page.evaluate(() => getComputedStyle(document.elementFromPoint(600, 300)).cursor)
  assert(!/resize/.test(cursor), `pointercancel left a global resize cursor: ${cursor}`)
  await page.mouse.up()
  results.cancelWithoutMouseUp = { cancel, afterHeldMove, cursor }

  const rememberedBeforeBreakpoint = (await geometry(page)).surfaceWidth
  const breakpointBox = await separator.boundingBox()
  await page.mouse.move(breakpointBox.x + breakpointBox.width / 2, breakpointBox.y + 120)
  await page.mouse.down()
  await page.mouse.move(breakpointBox.x - 35, breakpointBox.y + 120)
  await page.setViewportSize({ width: 1180, height })
  await page.mouse.up()
  await frames(page, { duration: 650 })
  const narrow = await geometry(page)
  assert.equal(narrow.expanded, 'false', 'Releasing an obsolete desktop drag reopened the compact overlay')
  await page.setViewportSize({ width, height })
  await setOpen(page, true)
  const returned = await geometry(page)
  assert(Math.abs(returned.surfaceWidth - rememberedBeforeBreakpoint) < 2, 'Crossing compact breakpoint overwrote remembered width with in-progress drag')
  results.breakpointDuringDrag = { rememberedBeforeBreakpoint, narrow, returned }

  await setOpen(page, true)
  const rightButton = await page.evaluate(() => new Promise(resolve => {
    document.querySelector('[data-inspector-toggle]').click()
    requestAnimationFrame(() => {
      const handle = document.querySelector('#inspector-resize')
      const rect = handle.getBoundingClientRect()
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 93, pointerType: 'mouse', isPrimary: true, button: 2, buttons: 2, clientX: rect.left, clientY: rect.top + 120 }))
      requestAnimationFrame(() => resolve({ phase: document.querySelector('.main-panes').dataset.inspectorMotion, separator: handle.dataset.separator, input: 'RAF-timed synthetic secondary-button pointerdown' }))
    })
  }))
  assert.notEqual(rightButton.phase, 'dragging', 'Secondary button interrupted the closing spring')
  await frames(page, { duration: 650 })
  const afterRightButton = await geometry(page)
  assert.equal(afterRightButton.expanded, 'false')
  assert(afterRightButton.spacerWidth < 1 && afterRightButton.phase === 'idle', 'Secondary click prevented closing from settling')
  results.secondaryButton = { rightButton, afterRightButton }

  hit = await grabClosingAtHitArea(page)
  await separator.focus()
  const beforeShrink = await geometry(page)
  const deltaToSmall = beforeShrink.spacerWidth - 90
  const shrunk = await moveFixturePointer(page, hit, deltaToSmall)
  assert(shrunk.spacerWidth < 140 && shrunk.spacerWidth > 0, 'Interrupted close fixture must finish below the 140px threshold')
  assert(Math.abs(shrunk.surfaceLeft - shrunk.spacerLeft) < 2, 'Shrinking interrupted close desynchronized surface position')
  await releaseFixturePointer(page, hit, deltaToSmall)
  await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
  const closed = await geometry(page)
  assert.equal(closed.expanded, 'false')
  assert(closed.spacerWidth < 1 && closed.phase === 'idle', 'Below-threshold interrupted close did not reach the closed endpoint')
  results.shrinkInterruptedClose = { hit, beforeShrink, shrunk, closed, focusRestored: true }
  await setOpen(page, true)
  return results
}

async function newScenario(width, height, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, recordVideo: { dir: `${outputDirectory}/video`, size: { width, height } } })
  await context.addInitScript(state => localStorage.setItem('goalward.preview.v1', JSON.stringify(state)), fixture)
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(baseUrl)
  await page.locator('.task-nav-item').filter({ hasText: fixture.tasks[0].title }).click()
  await expect(page.getByRole('heading', { name: fixture.tasks[0].title, exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), false, 'Must remain a browser preview')
  await expect(page.locator('#execution-inspector')).toHaveCount(1)
  await expect(page.locator('[data-inspector-toggle]')).toHaveAttribute('aria-controls', 'execution-inspector')
  await expect(page.getByRole('button', { name: '打开执行检查器', exact: true })).toHaveCount(1)
  const scenario = { viewport: { width, height }, reducedMotion, checks: {}, samples: {} }
  report.scenarios.push(scenario)
  return { context, page, scenario }
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    const { context, page, scenario } = await newScenario(width, height)
    try {
      await setOpen(page, false)
      await page.locator('#execution-inspector').evaluate(node => { window.__motionInspectorNode = node })
      scenario.samples.opening = await frames(page, { actions: [{ at: 0, open: true }] })
      scenario.checks.openingIntermediateFrames = intermediate(scenario.samples.opening.samples).length
      assert(scenario.checks.openingIntermediateFrames >= 2, 'Opening must contain actual slide frames')
      await page.screenshot({ path: `${outputDirectory}/open-${width}.png` })
      scenario.samples.closing = await frames(page, { actions: [{ at: 0, open: false }] })
      scenario.checks.closingIntermediateFrames = intermediate(scenario.samples.closing.samples).length
      assert(scenario.checks.closingIntermediateFrames >= 2, 'Closing must contain actual slide frames')
      scenario.samples.reversal = await frames(page, { duration: 1000, actions: [{ at: 0, open: true }, { at: 70, open: false }, { at: 135, open: true }, { at: 195, open: false }, { at: 260, open: true }] })
      scenario.checks.reversalSeams = checkContinuous(scenario.samples.reversal)
      assert.equal(await page.locator('#execution-inspector').evaluate(node => node === window.__motionInspectorNode), true, 'Toggle must preserve inspector DOM identity')

      const filter = page.getByRole('button', { name: '仅显示错误', exact: true })
      await filter.click()
      await expect(filter).toHaveAttribute('aria-pressed', 'true')
      const scroll = page.locator('#execution-inspector [data-radix-scroll-area-viewport]')
      await scroll.evaluate(node => { node.scrollTop = 480 })
      const scrollBefore = await scroll.evaluate(node => node.scrollTop)
      assert(scrollBefore > 100, 'Fixture must contain a real scrollable trace')
      await setOpen(page, false)
      await setOpen(page, true)
      await expect(filter).toHaveAttribute('aria-pressed', 'true')
      scenario.checks.traceScroll = { before: scrollBefore, after: await scroll.evaluate(node => node.scrollTop) }
      assert(Math.abs(scenario.checks.traceScroll.after - scrollBefore) <= 1, 'Close/reopen must preserve trace scroll')

      const separator = page.locator('#inspector-resize')
      await expect(separator).toBeVisible()
      await expect(page.locator('#inspector-space[data-panel]')).toHaveCount(1)
      await separator.evaluate(node => node.addEventListener('pointerdown', event => { window.__motionPointerId = event.pointerId }, { once: true }))
      const handle = await separator.boundingBox()
      const beforeDrag = await page.locator('#execution-inspector').evaluate(node => node.getBoundingClientRect().width)
      await page.mouse.move(handle.x + handle.width / 2, handle.y + Math.min(120, handle.height / 2))
      await page.mouse.down()
      const dragSamples = []
      for (const delta of [15, 35, 60]) {
        await page.mouse.move(handle.x + handle.width / 2 - delta, handle.y + Math.min(120, handle.height / 2))
        // The first RAF after each pointer move must already reflect the full
        // pointer displacement. A spring following resize would fail this.
        const actual = await page.locator('#execution-inspector').evaluate(node => new Promise(resolve => requestAnimationFrame(() => resolve(node.getBoundingClientRect().width))))
        dragSamples.push({ pointerDelta: delta, panelDelta: actual - beforeDrag })
        assert(Math.abs(actual - beforeDrag - delta) < 4, `Resize lag: ${JSON.stringify(dragSamples.at(-1))}`)
      }
      await separator.evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.__motionPointerId, pointerType: 'mouse' })))
      await page.mouse.up()
      const afterCancel = await page.locator('#execution-inspector').evaluate(node => node.getBoundingClientRect().width)
      await setOpen(page, false)
      await setOpen(page, true)
      const afterReopen = await page.locator('#execution-inspector').evaluate(node => node.getBoundingClientRect().width)
      assert(Math.abs(afterCancel - afterReopen) < 2, 'Resized width must survive pointercancel and reopen')
      scenario.checks.resize = { beforeDrag, dragSamples, afterCancel, afterReopen, pointerCancelThenToggle: true }

      if (width === 1536) scenario.checks.interruptionBoundaries = await boundaryChecks(page, width, height)

      await page.getByRole('button', { name: '收起检查器', exact: true }).click()
      await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
      await expect(page.locator('#execution-inspector')).toHaveAttribute('aria-hidden', 'true')
      assert.equal(await page.locator('#execution-inspector').evaluate(node => node.inert), true, 'Hidden panel must be inert immediately')
      for (let index = 0; index < 32; index++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.locator('#execution-inspector').evaluate(node => node.contains(document.activeElement)), false, 'Hidden panel received keyboard focus')
      }
      await page.locator('[data-inspector-toggle]').focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-inspector-toggle]')).toHaveAttribute('aria-expanded', 'true')
      await setOpen(page, true)
      scenario.checks.keyboard = { closeRestoresTrigger: true, hiddenPanelSkippedForTabs: 32, enterOpens: true }

      // This is a real React task-content update from browser fixture state.
      // It is deliberately not claimed as a native streaming-token test.
      const contentSamples = frames(page, { duration: 450 })
      await page.locator('.task-nav-item').filter({ hasText: fixture.tasks[1].title }).click()
      await expect(page.getByRole('heading', { name: fixture.tasks[1].title, exact: true })).toBeVisible()
      scenario.samples.contentChange = await contentSamples
      assert.equal(await page.locator('#execution-inspector').evaluate(node => node === window.__motionInspectorNode), true, 'Task content update remounted animated shell')
      assert(scenario.samples.contentChange.samples.every(sample => Math.abs(sample.x) < 0.5), 'Task content update restarted inspector entrance')
      scenario.checks.contentChange = { source: 'Synthetic task selection through the real UI', sameAnimatedNode: true, maxTranslation: Math.max(...scenario.samples.contentChange.samples.map(sample => Math.abs(sample.x))), realStreamingTested: false }
      scenario.checks.overflow = await assertNoOverflow(page)
      await page.screenshot({ path: `${outputDirectory}/verified-${width}.png` })
    } finally { await context.close() }
  }

  {
    const { context, page, scenario } = await newScenario(1180, 720)
    try {
      await expect(page.locator('[data-inspector-toggle]')).toHaveAttribute('aria-expanded', 'false')
      scenario.samples.overlayOpening = await frames(page, { actions: [{ at: 0, open: true }] })
      assert(intermediate(scenario.samples.overlayOpening.samples).length >= 2, 'Narrow-window overlay must slide')
      await expect(page.getByRole('button', { name: '收起检查器', exact: true })).toBeInViewport()
      const layout = await page.locator('#execution-inspector').evaluate(node => ({ position: getComputedStyle(node).position, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width, viewport: innerWidth }))
      assert(['absolute', 'fixed'].includes(layout.position), 'Narrow inspector must be an overlay')
      assert(layout.right <= layout.viewport + 1, 'Overlay is clipped beyond the window')
      scenario.checks.overlay = layout
      scenario.checks.overflow = await assertNoOverflow(page)
      await page.screenshot({ path: `${outputDirectory}/overlay-1180.png` })
      await page.getByRole('button', { name: '收起检查器', exact: true }).click()
      await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
    } finally { await context.close() }
  }

  {
    const { context, page, scenario } = await newScenario(1536, 960, 'reduce')
    try {
      await setOpen(page, false)
      scenario.samples.reduced = await frames(page, { duration: 700, actions: [{ at: 0, open: true }, { at: 150, open: false }, { at: 300, open: true }] })
      const movingFrames = intermediate(scenario.samples.reduced.samples)
      assert.equal(movingFrames.length, 0, 'Reduced motion must not contain intermediate slide positions')
      scenario.checks.reducedMotion = { intermediateSlideFrames: movingFrames.length, frameCount: scenario.samples.reduced.samples.length }
      await expect(page.getByRole('button', { name: '收起检查器', exact: true })).toBeInViewport()
      await page.screenshot({ path: `${outputDirectory}/reduced-motion.png` })
    } finally { await context.close() }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.status = 'passed'
  console.log(`PASS: inspector RAF motion, reversal, resize/cancel, focus, preserved trace state, desktop/overlay/reduced-motion fixtures. Artifacts: ${outputDirectory}`)
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(`${outputDirectory}/metrics.json`, `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
}
