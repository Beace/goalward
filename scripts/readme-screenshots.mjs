import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Run against the Vite development server: GOALWARD_SCREENSHOT_URL=http://127.0.0.1:1420 node scripts/readme-screenshots.mjs
// Isolated browser contexts contain illustrative data, never native workspace data or live agent executions.
const baseUrl = process.env.GOALWARD_SCREENSHOT_URL ?? 'http://127.0.0.1:1420'
const output = 'screenshots'
const checks = []
await mkdir(output, { recursive: true })
await mkdir('test-results/readme-screenshots', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function seed(page) {
  await page.goto(baseUrl)
  await page.evaluate(async () => {
    const { createInitialState } = await import('/src/lib/domain.ts')
    const { createGoal } = await import('/src/lib/goals.ts')
    const { createWorkspaceTask } = await import('/src/lib/workspace.ts')
    const { createAgentProfile, memberFromAgent } = await import('/src/lib/agent-profiles.ts')
    const state = createInitialState()
    state.settings.language = 'en'
    state.settings.theme = 'dark'
    state.settings.runtimes = state.settings.runtimes.filter(runtime => runtime.id !== 'traex')
    state.settings.runtimes.find(runtime => runtime.id === 'pi').enabled = true
    const at = '2026-10-13T02:00:00.000Z'
    const goal = createGoal({
      title: 'Make the workbench keyboard-first',
      intent: 'Help people move between goals, tasks, and agents without breaking focus.',
      expected: 'A command palette that makes everyday workspace actions easy to discover and use.',
      constraints: 'Keep the compact desktop layout. Preserve focus and existing shortcuts.',
      deadline: '2026-10-30',
      currentSummary: 'Command search and navigation are ready for review. Accessibility checks and documentation are next.',
      criteria: [
        { text: 'Find tasks and agents from one command palette', method: 'Review search results and keyboard navigation' },
        { text: 'Restore focus after every command', method: 'Check Escape, selection, and empty results' },
        { text: 'Document shortcuts and complete a desktop review', method: 'Review the guide and both desktop sizes' },
      ],
    }, at)
    goal.workingDirectories = ['/workspace/goalward']
    goal.criteria[0] = { ...goal.criteria[0], status: 'satisfied', evidence: 'Sample review: task and agent search accepted.', checkedAt: at }
    goal.definitions[0].criteria = structuredClone(goal.criteria)
    goal.plan = [
      { id: 'discovery', title: 'Define everyday commands', description: 'Agree on search and navigation scope.', status: 'done' },
      { id: 'implementation', title: 'Build and review the palette', description: 'Implement keyboard navigation and focus handling.', status: 'active' },
      { id: 'delivery', title: 'Verify and document', description: 'Complete accessibility checks and publish the guide.', status: 'planned' },
    ]
    state.goals = [goal, createGoal({ title: 'Improve artifact review', expected: 'Review delivered files inside the workspace.' }, at), createGoal({ title: 'Plan the next release' }, at)]
    state.agents = [
      createAgentProfile(state.settings, { name: 'Codex', role: 'Implementation', runtimeId: 'codex' }),
      createAgentProfile(state.settings, { name: 'Claude Code', role: 'Testing', runtimeId: 'claude' }),
      createAgentProfile(state.settings, { name: 'Pi', role: 'Review', runtimeId: 'pi' }),
    ]
    const titles = ['Build the command palette', 'Map workspace commands', 'Review task and agent search', 'Verify keyboard focus', 'Write the shortcut guide']
    state.tasks = titles.map((title, index) => {
      const task = createWorkspaceTask(state.settings, {
        title, goalId: goal.id, directory: '/workspace/goalward',
        acceptance: 'Search, arrow-key navigation, and Escape work without losing the previous focus.',
        members: index === 0 ? state.agents.map(memberFromAgent) : [memberFromAgent(state.agents[index % state.agents.length])],
      })
      task.createdAt = at
      task.businessStatus = ['review', 'done', 'done', 'in_progress', 'todo'][index]
      if (task.businessStatus === 'done') task.results = [{ id: `result-${index}`, summary: 'Sample accepted delivery', evidence: 'Illustrative acceptance record for this screenshot.', createdAt: at, verdict: 'accepted' }]
      return task
    })
    const task = state.tasks[0]
    const runId = 'example-run'
    task.runs = [{ id: runId, createdAt: at, directory: task.directory, prompt: 'Build the command palette and review keyboard behavior.', members: task.members.map(member => ({ ...member, runtime: structuredClone(state.settings.runtimes.find(runtime => runtime.id === member.runtimeId)), model: '', status: 'completed' })) }]
    task.messages = [
      { id: 'example-note', role: 'system', text: 'Example workspace: conversation and execution records are illustrative.', createdAt: at },
      { id: 'example-request', role: 'user', text: 'Build a command palette for finding tasks and agents. Keep arrow-key navigation, Escape, and focus restoration consistent across the workspace.', createdAt: at },
      { id: 'example-reply', role: 'assistant', memberId: task.members[0].id, runId, createdAt: at, text: 'The command palette is ready for review.\n\n- Search tasks and agents from a single entry point.\n- Use **↑ / ↓** to choose a result and **Enter** to open it.\n- Press **Escape** to return to the previous focus.\n\nThe next step is to review keyboard behavior and accept the task against its criteria.' },
      { id: 'example-review', role: 'assistant', memberId: task.members[2].id, runId, createdAt: at, text: 'Review focus handling and empty results before accepting the delivery. Task acceptance and goal verification remain separate.' },
    ]
    task.events = task.members.map((member, index) => ({ id: `example-event-${index}`, taskId: task.id, runId, memberId: member.id, timestamp: at, kind: 'completed', text: `Example record: ${member.role}. No real command was executed.`, exitCode: 0 }))
    state.activeTaskId = task.id
    state.activeGoalId = goal.id
    state.onboarding = { version: 1, completedAt: at, outcome: 'configured' }
    localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
  })
  await page.reload()
}

async function capture(page, name, width) {
  await page.evaluate(() => document.fonts.ready)
  // Capture settled presentation frames without changing the product's motion or layout.
  await page.waitForTimeout(700)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`)
  const path = width === 1536 ? `${output}/goalward-${name}-en.png` : `test-results/readme-screenshots/${name}-${width}.png`
  await page.mouse.move(0, 0)
  await page.screenshot({ path })
  checks.push({ name, width, path, horizontalOverflow: false })
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', deviceScaleFactor: 1, reducedMotion: 'no-preference' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await seed(page)
    await expect(page.getByRole('heading', { name: 'Make the workbench keyboard-first', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true')
    await capture(page, 'goals', width)

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: /^Tasks\s*\d+$/ }).click()
    await expect(page.locator('[data-task-heading]')).toHaveText('Build the command palette')
    await expect(page.getByRole('complementary', { name: 'Task list' })).toBeVisible()
    await page.getByRole('button', { name: 'Open execution inspector', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Run inspector' })).toBeVisible()
    await page.getByRole('complementary', { name: 'Run inspector' }).getByRole('button', { name: /^Run completed/ }).first().click()
    await expect(page.getByText('Example record: Implementation. No real command was executed.', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Task instruction' })).toBeInViewport()
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0 })
    await capture(page, 'workbench', width)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByRole('combobox', { name: 'Interface theme', exact: true }).click()
    await page.getByRole('option', { name: 'Cobalt2', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cobalt2')
    await expect(page.getByRole('slider', { name: 'Background image opacity', exact: true })).toBeInViewport()
    await expect(page.getByRole('slider', { name: 'Interface background opacity', exact: true })).toBeInViewport()
    await capture(page, 'appearance', width)
    assert.deepEqual(errors, [], `Page errors at ${width} × ${height}`)
    await context.close()
  }
  await writeFile('test-results/readme-screenshots/report.json', JSON.stringify({ baseUrl, scope: 'Current frontend in Chromium with isolated illustrative data; no native runtime execution.', checks }, null, 2))
  console.log(JSON.stringify(checks, null, 2))
} finally {
  await browser.close()
}
