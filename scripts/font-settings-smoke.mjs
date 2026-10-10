import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
const baseUrl = process.env.GOALWARD_SMOKE_URL ?? 'http://127.0.0.1:1420'
await mkdir('test-results/font-settings', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height }, reducedMotion })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.goto(baseUrl)
      await page.evaluate(async () => {
        const { createInitialState } = await import('/src/lib/domain.ts')
        const state = createInitialState()
        state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
        localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
      })
      await page.reload()
      const bodyFont = () => page.locator('body').evaluate(el => getComputedStyle(el).fontFamily)
      const defaultFont = await bodyFont()
      async function appearance() {
        await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.getByRole('button', { name: '外观', exact: true }).click()
      }
      async function pick(name) {
        await page.getByRole('combobox', { name: '界面字体', exact: true }).click()
        const search = page.getByRole('combobox', { name: '搜索字体', exact: true })
        await search.fill(name)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect(page.getByRole('combobox', { name: '界面字体', exact: true })).toBeFocused()
      }
      async function expectAutomaticSave(fontFamily) {
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.fontFamily)).toBe(fontFamily)
        await expect(page.getByText('外观已自动保存', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '保存更改', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: '还原', exact: true })).toHaveCount(0)
      }
      await appearance()
      await pick('Georgia')
      await expect(page.getByTestId('font-preview')).toHaveCSS('font-family', /^Georgia,/)
      await expect(page.locator('body')).toHaveCSS('font-family', /^Georgia,/)
      await expectAutomaticSave('Georgia')
      await page.reload()
      await expect(page.locator('body')).toHaveCSS('font-family', /^Georgia,/)
      await appearance()
      const picker = page.getByRole('combobox', { name: '界面字体', exact: true })
      await expect(picker).toContainText('Georgia')
      await picker.click()
      await expect(page.locator('[data-slot=popover-content]')).toHaveCSS('font-family', /^Georgia,/)
      await page.keyboard.press('Escape')
      await expect(picker).toBeFocused()
      await picker.press('Space')
      await page.keyboard.press('Escape')
      await expect(picker).toBeFocused()
      const client = await context.newCDPSession(page)
      await client.send('DOM.enable')
      await client.send('CSS.enable')
      const { root } = await client.send('DOM.getDocument')
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid=font-preview] p:nth-child(2)' })
      const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId })
      expect(fonts.some(font => font.familyName === 'Georgia' && font.glyphCount > 0)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      await expect(page.getByText('外观已自动保存', { exact: true })).toBeInViewport()
      await page.screenshot({ path: `test-results/font-settings/appearance-${width}-${reducedMotion}.png` })
      await page.getByRole('button', { name: '运行时', exact: true }).click()
      await expect(page.locator('#runtime-executable')).toHaveCSS('font-family', /monospace/)
      await page.getByRole('button', { name: '外观', exact: true }).click()
      await pick('应用默认')
      await expect(page.locator('body')).toHaveCSS('font-family', defaultFont)
      await expectAutomaticSave('')
      await page.reload()
      await expect(page.locator('body')).toHaveCSS('font-family', defaultFont)
      await appearance()
      await expect(page.getByRole('combobox', { name: '界面字体', exact: true })).toContainText('应用默认')
      expect(errors).toEqual([])
      results.push({ width, height, reducedMotion, locale: 'zh-CN', immediateFontChange: true, automaticSave: true, noManualSaveControls: true, persisted: true, defaultRestoredAndPersisted: true, portalInheritance: true, keyboardFocus: true, actualFonts: fonts, errors })
      await context.close()
    }
  }
  await writeFile('test-results/font-settings/results.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
