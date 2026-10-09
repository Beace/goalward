import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/markdown-links'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const key = 'goalward.preview.v1'
const results = []
try {
  for (const width of [1536, 1280]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width, height: width === 1536 ? 960 : 720 }, reducedMotion })
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', msg => { if (msg.type() === 'error') console.log('browser:', msg.text()) }); page.on('requestfailed', req => console.log('requestfailed:', req.url(), req.failure()))
    let remoteLoads = 0
    await page.route('https://artifact-preview.test/**', async route => {
      remoteLoads++
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>远程产物页面</h1><p>HTTP fixture loaded after click</p><script>try { parent.__artifactEscaped = true } catch {}</script>' })
    })
    await page.goto('http://127.0.0.1:1420')
    await page.waitForFunction(key => !!localStorage.getItem(key), key)
    await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key)); const at = '2026-09-17T09:00:00Z'
      const member = { id: 'member', name: 'Kimi CLI', role: '执行', runtimeId: 'kimi', modelId: '' }
      const runtime = { id: 'kimi', name: 'Kimi CLI', executable: 'kimi', adapter: 'kimi', enabled: true, args: [], defaultModel: '', description: '' }
      const task = { id: 'links-task', title: 'Markdown 链接产物预览验收', directory: '/tmp/current-directory', mode: 'solo', createdAt: at, members: [member], messages: [{ id: 'reply', role: 'assistant', text: '已完成。产出文件：`/tmp/link-fixture/business-quality.html`\n\n[执行清单](./docs/checklist.md)\n\n[远程报告](https://artifact-preview.test/report)\n\n裸链接：https://artifact-preview.test/other\n\n[缺失文件](./missing.md)', createdAt: at, runId: 'run', memberId: 'member' }], runs: [{ id: 'run', createdAt: at, directory: '/tmp/link-fixture', prompt: '生成报告', members: [{ ...member, runtime, model: '', status: 'completed' }] }], events: [], results: [], plan: [] }
      task.messages.unshift({ id: 'screenshot-reply', role: 'assistant', text: '这是一张 macOS「预览」应用的截图（文件名 `EC02548A-60C6-41C1-B883-4BE94F15C7AF.PNG`）。\n\n正文提到 photo.png 和 report.md。', createdAt: at, runId: 'run', memberId: 'member' })
      // Fixture-backed content verifies App routing/rendering; native disk reads remain separate.
      task.artifacts = [
        { path: '/tmp/link-fixture/business-quality.html', kind: 'html', content: '<h1>业务品质报告</h1><p>品质 = 标准 × 度量 × 闭环</p>' },
        { path: '/tmp/link-fixture/docs/checklist.md', kind: 'markdown', content: '# 执行清单\n\n[同目录文档](./detail.md)\n\n[返回报告](../business-quality.html)' },
        { path: '/tmp/link-fixture/docs/detail.md', kind: 'markdown', content: '# 同目录详情' },
      ].map((a, i) => ({ ...a, id: JSON.stringify([task.id, 'run', a.path]), name: a.path.split('/').at(-1), directory: '/tmp/link-fixture', runId: 'run', memberId: 'member', sourceId: 'saved-' + i, source: 'saved', createdAt: at }))
      state.tasks = [task]; state.goals = []; state.agents = []; state.activeTaskId = task.id; state.onboarding = { version: 1, completedAt: at, outcome: 'configured' }
      localStorage.setItem(key, JSON.stringify(state))
    }, key)
    await page.reload()
    await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: /^任务/ }).click()
    await page.getByRole('button', { name: '打开任务：Markdown 链接产物预览验收', exact: true }).click()
    const chat = page.getByLabel('任务对话记录')
    const preview = page.getByRole('complementary', { name: '产物预览' })
    const filename = 'EC02548A-60C6-41C1-B883-4BE94F15C7AF.PNG'
    await chat.locator('code').filter({ hasText: filename }).scrollIntoViewIfNeeded()
    await expect(chat.locator('code').filter({ hasText: filename })).toBeVisible()
    await expect(chat.getByRole('link', { name: filename, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: `预览 ${filename}`, exact: true })).toHaveCount(0)
    await expect(chat.getByRole('link', { name: /^(photo\.png|report\.md)$/ })).toHaveCount(0)
    await page.screenshot({ path: `${output}/filename-${width}-${reducedMotion}.png` })
    expect(remoteLoads).toBe(0)
    const path = chat.getByRole('link', { name: '/tmp/link-fixture/business-quality.html', exact: true })
    await path.focus(); await page.keyboard.press('Enter')
    await expect(page.frameLocator('iframe[title="business-quality.html HTML 预览"]').getByRole('heading', { name: '业务品质报告' })).toBeVisible()
    await expect(preview.getByRole('heading', { name: 'business-quality.html', exact: true })).toBeFocused()
    await page.waitForFunction(() => document.querySelector('[data-inspector-motion]')?.dataset.inspectorMotion === 'idle')
    await page.screenshot({ path: `${output}/local-${width}-${reducedMotion}.png` })
    await chat.getByRole('link', { name: '执行清单', exact: true }).click()
    await preview.getByRole('link', { name: '同目录文档' }).click()
    await expect(preview.getByRole('heading', { name: '同目录详情' })).toBeVisible()
    await chat.getByRole('link', { name: '执行清单', exact: true }).click()
    await preview.getByRole('link', { name: '返回报告' }).click()
    await expect(page.frameLocator('iframe[title="business-quality.html HTML 预览"]').getByRole('heading', { name: '业务品质报告' })).toBeVisible()
    await chat.getByRole('link', { name: '远程报告', exact: true }).click()
    await expect(page.frameLocator('iframe[title="artifact-preview.test 网页预览"]').getByRole('heading', { name: '远程产物页面' })).toBeVisible()
    expect(remoteLoads).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__artifactEscaped)).toBeUndefined()
    await expect(preview.getByRole('button', { name: '系统浏览器打开' })).toBeVisible()
    await page.screenshot({ path: `${output}/remote-${width}-${reducedMotion}.png` })
    await preview.getByRole('button', { name: '刷新网页' }).click()
    await expect(page.frameLocator('iframe').getByRole('heading', { name: '远程产物页面' })).toBeVisible()
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: '收起检查器' }).click()
      await path.click()
      await chat.getByRole('link', { name: '远程报告', exact: true }).click()
    }
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
    await chat.getByRole('link', { name: '缺失文件', exact: true }).click()
    await expect(preview.getByRole('alert')).toContainText('本地文件请在桌面应用中预览')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(errors).toEqual([])
    results.push({ width, reducedMotion, filenameMentionInert: true, noInventedArtifact: true, inlinePath: true, keyboard: true, historicDirectory: true, nestedRelativeLink: true, parentRelativeLink: true, remoteOnClick: true, isolatedFrame: true, refresh: true, rapidSwitch: true, focus: true, error: true, overflow: false, errors })
    await page.close()
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
