import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

// Browser-only evidence: isolated synthetic state, real application controls,
// and controlled samples of the application's actual WAAPI opacity animations.
const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:1420'
const output = 'test-results/date-picker'
await mkdir(output, { recursive: true })
const fixtureServer = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
let fixture
try {
  const { createInitialState, createTask } = await fixtureServer.ssrLoadModule('/src/lib/domain.ts')
  const { createGoal } = await fixtureServer.ssrLoadModule('/src/lib/goals.ts')
  fixture = createInitialState()
  const goal = createGoal({ title: 'Calendar fixture goal', expected: 'Persist date-only values', deadline: '2026-10-25', criteria: ['Date is selectable and clearable'], currentSummary: 'Isolated browser fixture; no real Runtime.' })
  goal.assistant = {
    confirmedVersion: goal.version,
    proposals: [{ id: 'calendar-proposal', title: 'Calendar fixture proposal', delivery: 'Readback', acceptance: 'Date-only persistence', deadline: '2026-10-20', dependsOn: [], status: 'suggested', baseGoalVersion: goal.version }, { id: 'calendar-adopted', title: 'Adopted fixture proposal', delivery: 'Readback', acceptance: 'Read-only', deadline: '2026-10-19', dependsOn: [], status: 'adopted', baseGoalVersion: goal.version }],
  }
  const task = createTask(fixture.settings, 'Calendar fixture task', '', 'solo')
  task.goalId = goal.id
  task.deadline = '2026-10-20'
  fixture = { ...fixture, tasks: [task], goals: [goal], activeGoalId: goal.id, activeTaskId: task.id, onboarding: { version: 1, completedAt: task.createdAt, outcome: 'configured' } }
} finally { await fixtureServer.close() }

const report = { status: 'running', baseUrl, scope: 'Real browser UI in isolated Chrome contexts with synthetic localStorage. No Tauri filesystem or real Runtime execution.', scenarios: [], failures: [] }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let activePage
const livePopover = page => page.locator('.date-picker-content:not([data-dialog-exit])')
const liveDialog = page => page.locator('[data-slot=dialog-content]:not([data-dialog-exit])')
const storage = page => page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')))
const findGoal = (state, title) => state.goals.find(goal => goal.title === title)

async function geometry(page, locator, label) {
  const box = await locator.boundingBox()
  assert(box, `${label}: no visible bounds`)
  const viewport = page.viewportSize()
  assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label}: clipped bounds ${JSON.stringify(box)}`)
  return box
}

async function settle(page) {
  await page.evaluate(() => {
    window.__dateMotion?.records.forEach(({ animation }) => {
      if (animation.playState !== 'idle' && animation.playState !== 'finished') animation.finish()
    })
  })
  await page.waitForFunction(() => !document.querySelector('[data-dialog-exit=popover]'))
}

async function openCalendar(page, trigger, key) {
  await expect(trigger).toBeVisible()
  if (key) { await trigger.focus(); await trigger.press(key) }
  else await trigger.click()
  await expect(livePopover(page)).toBeVisible()
  await settle(page)
  const selected = livePopover(page).locator('button[data-selected-single=true]')
  if (await selected.count()) await expect(selected).toBeFocused()
  else assert(await page.evaluate(() => Boolean(document.activeElement?.hasAttribute('data-day'))), 'Opening calendar did not focus its roving day')
  return livePopover(page)
}

async function selectDate(page, trigger, day, key) {
  const calendar = await openCalendar(page, trigger, key)
  await calendar.locator('button[data-day]').filter({ hasText: new RegExp(`^${day}$`) }).click()
  await expect(livePopover(page)).toHaveCount(0)
  await settle(page)
}

async function clearDate(page, trigger, clearName) {
  await openCalendar(page, trigger)
  await livePopover(page).getByRole('button', { name: clearName, exact: true }).click()
  await expect(trigger).toHaveAttribute('data-empty', 'true')
  await settle(page)
}

async function motionCheck(page, trigger, reducedMotion) {
  await page.evaluate(() => {
    const original = Element.prototype.animate
    window.__dateMotion = { records: [], original }
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args)
      if (this.matches('[data-slot=popover-content]')) {
        animation.pause()
        animation.currentTime = 0
        window.__dateMotion.records.push({ node: this, animation })
      }
      return animation
    }
  })
  await trigger.focus(); await trigger.press('Enter')
  await expect(livePopover(page)).toBeVisible()
  const sample = fraction => page.evaluate(fraction => {
    const record = window.__dateMotion.records.at(-1)
    if (!record) return null
    record.animation.currentTime = Number(record.animation.effect.getComputedTiming().duration) * fraction
    const style = getComputedStyle(record.node)
    const box = record.node.getBoundingClientRect()
    return { opacity: Number(style.opacity), duration: record.animation.effect.getComputedTiming().duration, keyframes: record.animation.effect.getKeyframes(), transform: style.transform, rect: { x: box.x, y: box.y, width: box.width, height: box.height }, ghost: record.node.hasAttribute('data-dialog-exit'), inert: record.node.hasAttribute('inert'), hidden: record.node.getAttribute('aria-hidden'), pointerEvents: style.pointerEvents, duplicateIds: record.node.querySelectorAll('[id]').length, roles: record.node.querySelectorAll('[role]').length }
  }, fraction)
  if (reducedMotion === 'reduce') {
    assert.equal(await page.evaluate(() => window.__dateMotion.records.length), 0, 'Reduced motion created a popover animation')
    await page.keyboard.press('Escape')
    await expect(livePopover(page)).toHaveCount(0)
    assert.equal(await page.locator('[data-dialog-exit=popover]').count(), 0, 'Reduced motion retained an exit copy')
    return { reducedMotion, animationCount: 0 }
  }
  const first = await sample(0)
  assert(first && first.duration > 0 && first.duration <= 121, 'Popover has no actual quick fade')
  assert(first.keyframes.every(frame => Object.keys(frame).every(key => ['opacity', 'offset', 'computedOffset', 'easing', 'composite'].includes(key))), 'Popover animation changes more than opacity')
  const midpoint = await sample(0.42)
  assert(midpoint.opacity > first.opacity && midpoint.opacity < 1, 'Popover fade lacks an intermediate presentation')
  await page.keyboard.press('Escape')
  await expect(livePopover(page)).toHaveCount(0)
  await expect(trigger).toBeFocused()
  const outgoing = await sample(0)
  assert(outgoing?.ghost && outgoing.inert && outgoing.hidden === 'true' && outgoing.pointerEvents === 'none' && !outgoing.duplicateIds && !outgoing.roles, 'Exit copy must be inert, hidden and free of live IDs/roles')
  assert(Math.abs(outgoing.opacity - midpoint.opacity) <= 0.02, `Close snapped opacity: ${midpoint.opacity} to ${outgoing.opacity}`)
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(outgoing.rect[key] - midpoint.rect[key]) <= 1, `Exit changed ${key}`)
  const seams = []
  for (let index = 0; index < 3; index++) {
    const before = await sample(0.35)
    await trigger.press('Enter')
    await expect(livePopover(page)).toBeVisible()
    assert.equal(await page.locator('[data-dialog-exit=popover]').count(), 0, 'Reopen left a duplicated calendar')
    const incoming = await sample(0)
    assert(Math.abs(incoming.opacity - before.opacity) <= 0.02, `Reopen ${index} snapped opacity`)
    const reverse = await sample(0.37)
    await page.keyboard.press('Escape')
    const next = await sample(0)
    assert(next?.ghost && Math.abs(next.opacity - reverse.opacity) <= 0.02, `Close ${index} snapped opacity`)
    seams.push({ before, incoming, reverse, next })
  }
  await settle(page)
  return { reducedMotion, first, midpoint, outgoing, seams }
}

try {
  for (const config of [
    { width: 1536, height: 960, language: 'zh', theme: 'dark', reducedMotion: 'no-preference' },
    { width: 1280, height: 720, language: 'en', theme: 'light', reducedMotion: 'no-preference' },
    { width: 1280, height: 720, language: 'zh', theme: 'light', reducedMotion: 'reduce' },
    { width: 1536, height: 960, language: 'en', theme: 'dark', reducedMotion: 'reduce' },
  ]) {
    const scenario = { ...config, checks: [], errors: [] }
    report.scenarios.push(scenario)
    const labels = config.language === 'zh'
      ? { createGoal: '创建目标', manualGoal: '手动创建目标', createTask: '创建任务', revise: '修订', save: '保存', clear: '清除日期', cancel: '取消', assistant: '目标助手', tasks: /^任务/, edit: '编辑任务：Calendar fixture task', saveTask: '保存任务', executor: '新任务执行者', human: '人工 / 应用外完成' }
      : { createGoal: 'Create goal', manualGoal: 'Create goal manually', createTask: 'Create task', revise: 'Revise', save: 'Save', clear: 'Clear date', cancel: 'Cancel', assistant: 'Goal assistant', tasks: /^Tasks/, edit: 'Edit task: Calendar fixture task', saveTask: 'Save task', executor: 'Executor for new task', human: 'Human / completed outside the app' }
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, reducedMotion: config.reducedMotion, timezoneId: 'Asia/Shanghai' })
    const page = activePage = await context.newPage()
    page.setDefaultTimeout(10000)
    console.log(`Checking ${config.width} ${config.language} ${config.theme} ${config.reducedMotion}`)
    page.on('pageerror', error => scenario.errors.push(error.message))
    await page.clock.setFixedTime(new Date('2026-10-13T04:00:00Z'))
    const seeded = structuredClone(fixture)
    seeded.settings.language = config.language
    seeded.settings.theme = config.theme
    await page.addInitScript(state => { if (!localStorage.getItem('goalward.preview.v1')) localStorage.setItem('goalward.preview.v1', JSON.stringify(state)) }, seeded)
    await page.goto(baseUrl)
    await expect(page.getByRole('heading', { name: 'Calendar fixture goal', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', config.theme)
    await page.locator('.goal-picker-heading button').click()
    const createGoal = page.getByRole('button', { name: labels.manualGoal, exact: true })
    await createGoal.click()
    const goalDate = page.locator('#goal-deadline')
    await expect(goalDate).toHaveAttribute('type', 'button')
    scenario.motion = await motionCheck(page, goalDate, config.reducedMotion)
    scenario.checks.push('Actual opacity fade, inert exit lifecycle, presentation continuity on rapid reversal, and reduced motion')
    await openCalendar(page, goalDate, 'Space')
    const keyboardDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day'))
    assert(keyboardDay, 'Space trigger did not focus a calendar day')
    await page.keyboard.press('ArrowRight')
    const nextKeyboardDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day'))
    assert(nextKeyboardDay && nextKeyboardDay !== keyboardDay, 'Arrow key did not move calendar focus')
    await page.keyboard.press('Enter')
    await expect(goalDate).toHaveAttribute('data-empty', 'false')
    await settle(page)
    await openCalendar(page, goalDate, 'Enter')
    await expect(livePopover(page)).toHaveCSS('opacity', '1')
    await expect(liveDialog(page)).toHaveCSS('opacity', '1')
    scenario.goalCalendarBounds = await geometry(page, livePopover(page), 'Create goal calendar')
    await page.screenshot({ path: `${output}/new-goal-${config.width}-${config.language}-${config.theme}-${config.reducedMotion}.png` })
    await page.keyboard.press('Escape')
    await expect(livePopover(page)).toHaveCount(0)
    await expect(liveDialog(page)).toBeVisible()
    await expect(goalDate).toBeFocused()
    await settle(page)
    await page.keyboard.press('Escape')
    await expect(liveDialog(page)).toHaveCount(0)
    await expect(createGoal).toBeFocused()
    scenario.checks.push('Enter/Space open, arrow/Enter date selection, Escape calendar then parent dialog, focus restoration')
    await createGoal.click()
    const createdTitle = `Date picker created goal ${config.language}`
    await page.locator('#goal-title').fill(createdTitle)
    await page.locator('#goal-expected').fill('Date-only persistence')
    await page.locator('#goal-criteria').fill('Choose and clear a deadline')
    await selectDate(page, goalDate, 20)
    await liveDialog(page).getByRole('button', { name: labels.createGoal, exact: true }).click()
    await expect.poll(async () => findGoal(await storage(page), createdTitle)?.deadline).toBe('2026-10-20')
    await page.reload()
    await page.getByRole('button', { name: labels.revise, exact: true }).click()
    await selectDate(page, goalDate, 21)
    await page.locator('#goal-reason').fill('Calendar UI smoke')
    await liveDialog(page).getByRole('button', { name: labels.save, exact: true }).click()
    await expect.poll(async () => findGoal(await storage(page), createdTitle)?.deadline).toBe('2026-10-21')
    await page.getByRole('button', { name: labels.revise, exact: true }).click()
    await clearDate(page, goalDate, labels.clear)
    await page.locator('#goal-reason').fill('Clear deadline smoke')
    await liveDialog(page).getByRole('button', { name: labels.save, exact: true }).click()
    await expect.poll(async () => findGoal(await storage(page), createdTitle)?.deadline).toBe('')
    scenario.checks.push('Create and revise goal, date-only storage/readback after reload, clear goal deadline')

    await page.locator('.goal-picker-list').getByRole('button', { name: /Calendar fixture goal/ }).click()
    await page.getByRole('tab', { name: labels.assistant, exact: true }).click()
    const assistantDate = page.locator(`[id="assistant-deadline-${fixture.goals[0].id}"]`)
    await selectDate(page, assistantDate, 22)
    await expect.poll(async () => findGoal(await storage(page), 'Calendar fixture goal')?.assistant?.draft?.deadline).toBe('2026-10-22')
    assert.equal(findGoal(await storage(page), 'Calendar fixture goal').deadline, '2026-10-25', 'Assistant draft changed the goal definition')
    await clearDate(page, assistantDate, labels.clear)
    await expect.poll(async () => findGoal(await storage(page), 'Calendar fixture goal')?.assistant?.draft?.deadline).toBe('')
    await page.getByRole('tab', { name: labels.tasks }).click()
    const proposalRow = page.locator('.goal-task-proposal-row').filter({ has: page.locator('input[value="Calendar fixture proposal"]') })
    await proposalRow.locator('.goal-disclosure').click()
    const proposalDate = proposalRow.locator('.date-picker-trigger')
    await selectDate(page, proposalDate, 23)
    await expect.poll(async () => findGoal(await storage(page), 'Calendar fixture goal')?.assistant?.proposals?.find(item => item.id === 'calendar-proposal')?.deadline).toBe('2026-10-23')
    await clearDate(page, proposalDate, labels.clear)
    await expect.poll(async () => findGoal(await storage(page), 'Calendar fixture goal')?.assistant?.proposals?.find(item => item.id === 'calendar-proposal')?.deadline).toBe('')
    const adoptedRow = page.locator('.goal-task-proposal-row').filter({ has: page.locator('input[value="Adopted fixture proposal"]') })
    await adoptedRow.locator('.goal-disclosure').click()
    await expect(adoptedRow.locator('.date-picker-trigger')).toBeDisabled()
    scenario.checks.push('Assistant draft and editable task proposal persistence/clear, adopted proposal disabled')

    await page.locator('.goal-header-actions').getByRole('button', { name: labels.createTask, exact: true }).click()
    await page.locator('#task-title').fill(`Date picker created task ${config.language}`)
    const taskDate = page.locator('#task-deadline')
    await openCalendar(page, taskDate)
    await expect(livePopover(page).locator('button[data-day]').filter({ hasText: /^26$/ })).toBeDisabled()
    await expect(livePopover(page).locator('button[data-day]').filter({ hasText: /^25$/ })).toBeEnabled()
    await livePopover(page).locator('button[data-day]').filter({ hasText: /^24$/ }).click()
    await settle(page)
    await page.getByRole('combobox', { name: labels.executor }).click()
    await page.getByRole('option', { name: labels.human, exact: true }).click()
    await liveDialog(page).getByRole('button', { name: labels.createTask, exact: true }).click()
    await expect.poll(async () => (await storage(page)).tasks.find(item => item.title === `Date picker created task ${config.language}`)?.deadline).toBe('2026-10-24')
    scenario.checks.push('Create task with date-only deadline, goal deadline disables later dates')

    await page.getByRole('button', { name: /Calendar fixture task/ }).first().click()
    await page.getByRole('button', { name: labels.edit, exact: true }).click()
    const editedDate = page.locator('#edit-task-deadline')
    await openCalendar(page, editedDate)
    await expect(livePopover(page)).toHaveCSS('opacity', '1')
    await expect(liveDialog(page)).toHaveCSS('opacity', '1')
    scenario.taskEditBounds = await geometry(page, livePopover(page), 'Task edit calendar')
    await page.screenshot({ path: `${output}/task-edit-${config.width}-${config.language}-${config.theme}-${config.reducedMotion}.png` })
    await livePopover(page).locator('button[data-day]').filter({ hasText: /^21$/ }).click()
    await settle(page)
    await liveDialog(page).getByRole('button', { name: labels.saveTask, exact: true }).click()
    await expect.poll(async () => (await storage(page)).tasks.find(item => item.id === fixture.tasks[0].id)?.deadline).toBe('2026-10-21')
    await page.getByRole('button', { name: labels.edit, exact: true }).click()
    await clearDate(page, editedDate, labels.clear)
    await liveDialog(page).getByRole('button', { name: labels.saveTask, exact: true }).click()
    await expect.poll(async () => (await storage(page)).tasks.find(item => item.id === fixture.tasks[0].id)?.deadline).toBe('')
    await page.reload()
    assert.equal((await storage(page)).tasks.find(item => item.id === fixture.tasks[0].id).deadline, '')
    assert.equal(await page.locator('input[type=date]').count(), 0, 'Native date input remains in active application view')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Horizontal viewport overflow')
    assert.deepEqual(scenario.errors, [])
    scenario.checks.push('Task edit save/readback/clear/reload, viewport fits and no browser exceptions')
    scenario.passed = true
    console.log(`Passed ${config.width} ${config.language} ${config.theme} ${config.reducedMotion}`)
    await context.close()
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failures.push(error.stack ?? String(error))
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(`${output}/qa.json`, `${JSON.stringify(report, null, 2)}\n`)
  await browser.close()
}
console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.map(({ width, language, theme, reducedMotion, passed, checks }) => ({ width, language, theme, reducedMotion, passed, checks })), failures: report.failures }))
