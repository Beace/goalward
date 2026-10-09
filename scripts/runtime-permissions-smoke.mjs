import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

await mkdir('test-results/runtime-permissions', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
      const page = await context.newPage()
      await page.goto('http://127.0.0.1:1420')
      await page.evaluate(async () => {
        const { createInitialState } = await import('/src/lib/domain.ts')
        const state = createInitialState()
        state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
        localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
      })
      await page.reload()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('combobox', { name: '文件访问范围' })).toContainText('完整访问')
      await page.getByRole('button', { name: /Kimi CLI/ }).click()
      const select = page.getByRole('combobox', { name: '工具审批模式' })
      await expect(select).toContainText('自动批准全部工具')
      await select.click()
      await expect(page.getByRole('option', { name: '手动审批', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(select).toBeFocused()
      await select.press('Space')
      await page.getByRole('option', { name: '手动审批', exact: true }).click()
      await expect(select).toContainText('手动审批')
      await select.click()
      await page.keyboard.press('Escape')
      await select.click()
      await page.getByRole('option', { name: '自动批准全部工具（默认）', exact: true }).click()
      await expect(select).toBeFocused()
      await page.getByRole('button', { name: '保存更改', exact: true }).click()
      await page.reload()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: /Kimi CLI/ }).click()
      await expect(page.getByRole('combobox', { name: '工具审批模式' })).toContainText('自动批准全部工具')
      await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      await page.getByRole('button', { name: '访问权限', exact: true }).click()
      await expect(page.getByRole('combobox', { name: '工具审批模式' })).toBeInViewport()
      await page.screenshot({ path: `test-results/runtime-permissions/${width}-${reducedMotion}.png` })
      results.push({ width, height, reducedMotion, defaultAuto: true, manualSwitch: true, keyboardFocus: true, persisted: true, overflow: false })
      await context.close()
    }
  }
  await writeFile('test-results/runtime-permissions/ui.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
