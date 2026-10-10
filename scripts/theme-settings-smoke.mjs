import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const baseUrl = process.env.GOALWARD_SMOKE_URL || 'http://127.0.0.1:1420'
const output = 'test-results/theme-settings'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      for (const initialSystem of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme: initialSystem })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(baseUrl)
        await page.evaluate(async () => {
          const { createInitialState } = await import('/src/lib/domain.ts')
          const state = createInitialState()
          // Also exercise a legacy workspace with no appearance preference.
          delete state.settings.theme
          state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
          localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
        })
        await page.reload()
        const root = page.locator('html')
        await expect(root).toHaveAttribute('data-theme', initialSystem)
        async function appearance() {
          await page.getByRole('button', { name: '设置', exact: true }).click()
          await page.getByRole('button', { name: '外观', exact: true }).click()
        }
        const picker = page.getByRole('combobox', { name: '界面主题', exact: true })
        async function pick(label) {
          await picker.click()
          await page.getByRole('option', { name: label, exact: true }).click()
          await expect(picker).toBeFocused()
        }
        async function save(theme) {
          await page.getByRole('button', { name: '保存更改', exact: true }).click()
          await expect(page.getByText('所有更改已保存', { exact: true })).toBeVisible()
          await expect(root).toHaveAttribute('data-theme', theme)
          await expect(root).not.toHaveClass(/theme-changing/)
        }
        await appearance()
        await expect(picker).toContainText('跟随系统')
        await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeDisabled()
        await page.evaluate(() => {
          window.themeMenuExits = []
          window.themeMenuObserver = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node instanceof HTMLElement && node.matches('[data-dialog-exit=popover]')) {
                window.themeMenuExits.push({ inert: node.inert, hidden: node.getAttribute('aria-hidden'), animations: node.getAnimations().map(animation => animation.effect.getKeyframes()) })
              }
            }
          })
          window.themeMenuObserver.observe(document.body, { childList: true })
        })
        await picker.click()
        const menuEntrance = await page.getByRole('listbox').evaluate(el => el.getAnimations().map(animation => animation.effect.getKeyframes()))
        await expect(page.getByRole('option', { name: '跟随系统', exact: true })).toBeFocused()
        await expect(page.getByRole('listbox')).toHaveCSS('opacity', '1')
        await page.keyboard.press('Escape')
        await expect(picker).toBeFocused()
        const menuExit = await page.evaluate(() => { window.themeMenuObserver.disconnect(); return window.themeMenuExits })
        if (reducedMotion === 'no-preference') {
          expect(menuEntrance.length).toBeGreaterThan(0)
          expect(menuExit.length).toBe(1)
          expect(menuExit[0].inert).toBe(true)
          expect(menuExit[0].hidden).toBe('true')
          expect(menuExit[0].animations.length).toBeGreaterThan(0)
        } else {
          expect(menuEntrance).toEqual([])
          expect(menuExit).toEqual([])
        }
        await picker.press('Space')
        await expect(page.getByRole('option', { name: '跟随系统', exact: true })).toBeFocused()
        await expect(page.getByRole('listbox')).toHaveCSS('opacity', '1')
        await page.keyboard.press('Escape')
        await picker.press('Space')
        const menuReopen = await page.getByRole('listbox').evaluate(el => el.getAnimations().map(animation => animation.effect.getKeyframes()))
        if (reducedMotion === 'no-preference') {
          expect(menuReopen.length).toBeGreaterThan(0)
          expect(Number(menuReopen[0][0].opacity)).toBeGreaterThan(0)
        } else expect(menuReopen).toEqual([])
        await page.keyboard.press('Escape')
        await expect(picker).toBeFocused()
        await pick('浅色')
        await expect(root).toHaveAttribute('data-theme', initialSystem)
        await page.getByRole('button', { name: '还原', exact: true }).click()
        await expect(picker).toContainText('跟随系统')

        const surfaces = []
        for (const [preference, label] of [['light', '浅色'], ['dark', '深色']]) {
          await pick(label)
          await save(preference)
          await expect(root).toHaveCSS('color-scheme', preference)
          const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.theme)
          expect(persisted).toBe(preference)
          await page.emulateMedia({ colorScheme: preference === 'dark' ? 'light' : 'dark' })
          await expect(root).toHaveAttribute('data-theme', preference)
          // Portaled font picker, theme menu and notifications share the palette.
          await picker.press('Space')
          await expect(page.getByRole('listbox')).toBeVisible()
          const menuColor = await page.locator('[data-slot=select-content]').evaluate(el => getComputedStyle(el).backgroundColor)
          await page.keyboard.press('Escape')
          await expect(picker).toBeFocused()
          await page.getByRole('combobox', { name: '界面字体', exact: true }).click()
          await expect(page.locator('[data-slot=popover-content]')).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('combobox', { name: '界面字体', exact: true })).toBeFocused()
          const colors = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement)
            return Object.fromEntries(['background', 'foreground', 'muted-foreground', 'sidebar', 'card', 'status-success', 'destructive'].map(name => [name, root.getPropertyValue('--' + name).trim()]))
          })
          expect(menuColor).toBe(preference === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 34, 34)')
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
          await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeInViewport()
          const name = `${width}-${reducedMotion}-${initialSystem}-${preference}`
          await page.screenshot({ path: `${output}/appearance-${name}.png` })
          await page.reload()
          await expect(root).toHaveAttribute('data-theme', preference)
          await appearance()
          await expect(picker).toContainText(label)
          await page.getByRole('button', { name: '运行时', exact: true }).click()
          await expect(page.locator('#runtime-executable')).toHaveCSS('font-family', /monospace/)
          const piPixels = await page.locator('[data-runtime-logo=pi] img').first().evaluate(async img => {
            await img.decode()
            const canvas = document.createElement('canvas')
            canvas.width = 16; canvas.height = 16
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0, 16, 16)
            const pixels = ctx.getImageData(0, 0, 16, 16).data
            const visible = []
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200) visible.push(pixels[i])
            return Math.round(visible.reduce((sum, value) => sum + value, 0) / visible.length)
          })
          expect(piPixels).toBe(preference === 'light' ? 17 : 246)
          await page.getByRole('button', { name: '返回工作台', exact: true }).click()
          await page.getByRole('button', { name: /为工作台增加全局命令面板/ }).click()
          await expect(page.locator('.task-heading')).toBeVisible()
          await page.screenshot({ path: `${output}/workbench-${name}.png` })
          await page.getByRole('button', { name: '新建任务', exact: true }).click()
          await expect(page.getByRole('dialog')).toBeVisible()
          const dialogColor = await page.locator('[data-slot=dialog-content]').evaluate(el => getComputedStyle(el).backgroundColor)
          expect(dialogColor).toBe(menuColor)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toBeHidden()
          await appearance()
          surfaces.push({ preference, colors, menuColor, dialogColor, piPixels })
        }

        await pick('跟随系统')
        await page.emulateMedia({ colorScheme: 'light' })
        await save('light')
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect(root).toHaveAttribute('data-theme', 'dark')
        await expect(root).not.toHaveClass(/theme-changing/)
        await page.emulateMedia({ colorScheme: 'light' })
        await expect(root).toHaveAttribute('data-theme', 'light')
        await expect(root).not.toHaveClass(/theme-changing/)
        await page.reload()
        await expect(root).toHaveAttribute('data-theme', 'light')
        await appearance()
        await expect(picker).toContainText('跟随系统')

        // Exercise reversals before the shared color feedback finishes.
        const samples = []
        for (const colorScheme of ['dark', 'light', 'dark', 'light']) {
          await page.emulateMedia({ colorScheme })
          await expect(root).toHaveAttribute('data-theme', colorScheme)
          samples.push(await page.locator('.titlebar').evaluate(el => ({
            theme: document.documentElement.dataset.theme,
            background: getComputedStyle(el).backgroundColor,
          })))
        }
        await expect(root).not.toHaveClass(/theme-changing/)
        await picker.press('Space')
        await expect(page.getByRole('listbox')).toBeVisible()
        await expect(page.getByRole('option', { name: '跟随系统', exact: true })).toBeFocused()
        await page.keyboard.press('End')
        await expect(page.getByRole('option', { name: '浅色', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(picker).toBeFocused()
        await expect(picker).toContainText('浅色')
        await page.getByRole('button', { name: '还原', exact: true }).click()
        await pick('深色')
        await page.evaluate(() => {
          const original = Storage.prototype.setItem
          window.restoreThemeStorage = () => { Storage.prototype.setItem = original }
          Storage.prototype.setItem = function(key, value) {
            if (key === 'goalward.preview.v1') throw new Error('Theme smoke storage unavailable')
            return original.call(this, key, value)
          }
        })
        await page.getByRole('button', { name: '保存更改', exact: true }).click()
        await expect(page.getByRole('alert').filter({ hasText: '保存失败' }).first()).toBeVisible()
        await expect(root).toHaveAttribute('data-theme', 'light')
        await expect(picker).toContainText('深色')
        await page.evaluate(() => { window.restoreThemeStorage(); delete window.restoreThemeStorage })
        await page.getByRole('button', { name: '还原', exact: true }).click()
        await expect(picker).toContainText('跟随系统')
        expect(errors).toEqual([])
        results.push({ width, height, reducedMotion, initialSystem, savedAndReloaded: true, followsSystemLive: true, explicitOverride: true, restored: true, saveFailureRollback: true, keyboardFocus: true, menuEntrance, menuExit, menuReopen, surfaces, reversalSamples: samples, errors })
        console.log(`PASS theme ${width}x${height} ${reducedMotion} OS ${initialSystem}`)
        await context.close()
      }
    }
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  console.log(`PASS ${results.length} theme scenarios; screenshots in ${output}`)
} finally { await browser.close() }
