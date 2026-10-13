import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const baseUrl = process.env.GOALWARD_SMOKE_URL || 'http://127.0.0.1:1420'
const output = 'test-results/theme-settings'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
function contrast(foreground, background) {
  function luminance(color) {
    const channels = color.startsWith('#')
      ? color.slice(1).match(/.{2}/g).map(channel => Number.parseInt(channel, 16))
      : color.startsWith('color(srgb ')
        ? color.match(/[\d.]+/g).slice(0, 3).map(channel => Number(channel) * 255)
        : color.match(/[\d.]+/g).slice(0, 3).map(Number)
    expect(channels).toHaveLength(3)
    const [red, green, blue] = channels.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      for (const initialSystem of ['dark', 'light']) {
        const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion, colorScheme: initialSystem })
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
        async function saved(theme, preference) {
          await expect(root).toHaveAttribute('data-theme', theme)
          await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.theme)).toBe(preference)
          await expect(page.getByText('外观已自动保存', { exact: true })).toBeVisible()
          await expect(root).not.toHaveClass(/theme-changing/)
        }
        await appearance()
        await expect(picker).toContainText('跟随系统')
        await expect(page.getByRole('button', { name: '保存更改', exact: true })).toHaveCount(0)
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
        await saved('light', 'light')
        await pick('跟随系统')
        await saved(initialSystem, 'system')
        await expect(picker).toContainText('跟随系统')

        const surfaces = []
        for (const { preference, label, colorScheme, surfaceColor, logoBrightness } of [
          { preference: 'light', label: '浅色', colorScheme: 'light', surfaceColor: 'rgb(255, 255, 255)', logoBrightness: 17 },
          { preference: 'dark', label: '深色', colorScheme: 'dark', surfaceColor: 'rgb(32, 34, 34)', logoBrightness: 246 },
          { preference: 'cobalt2', label: 'Cobalt2', colorScheme: 'dark', surfaceColor: 'rgb(18, 39, 56)', logoBrightness: 246 },
        ]) {
          await pick(label)
          await saved(preference, preference)
          await expect(root).toHaveCSS('color-scheme', colorScheme)
          if (colorScheme === 'dark') await expect(root).toHaveClass(/(^|\s)dark(\s|$)/)
          else await expect(root).not.toHaveClass(/(^|\s)dark(\s|$)/)
          const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.theme)
          expect(persisted).toBe(preference)
          for (const systemScheme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: systemScheme })
            await expect(root).toHaveAttribute('data-theme', preference)
            await expect(root).toHaveCSS('color-scheme', colorScheme)
          }
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
            return Object.fromEntries(['background', 'foreground', 'muted-foreground', 'sidebar', 'card', 'primary', 'primary-foreground', 'ring', 'secondary', 'accent', 'status-success', 'status-success-surface', 'destructive', 'destructive-surface'].map(name => [name, root.getPropertyValue('--' + name).trim()]))
          })
          const contrastRatios = preference === 'cobalt2' ? {
            foreground: contrast(colors.foreground, colors.background),
            mutedForeground: contrast(colors['muted-foreground'], colors.background),
            primaryButton: contrast(colors['primary-foreground'], colors.primary),
            success: contrast(colors['status-success'], colors.background),
            successSurface: contrast(colors['status-success'], colors['status-success-surface']),
            error: contrast(colors.destructive, colors.background),
            errorSurface: contrast(colors.destructive, colors['destructive-surface']),
          } : null
          if (preference === 'cobalt2') {
            expect(colors).toMatchObject({ background: '#193549', foreground: '#ffffff', sidebar: '#15232d', card: '#122738', primary: '#ffc600', ring: '#ffc600', secondary: '#1f4662', accent: '#0d3a58' })
            for (const [name, ratio] of Object.entries(contrastRatios)) expect(ratio, `Cobalt2 ${name} contrast`).toBeGreaterThanOrEqual(4.5)
          }
          expect(menuColor).toBe(surfaceColor)
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
          await expect(page.getByText('外观已自动保存', { exact: true })).toBeInViewport()
          await expect(page.locator('[data-dialog-exit]')).toHaveCount(0)
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
          expect(piPixels).toBe(logoBrightness)
          await page.getByRole('button', { name: '返回工作台', exact: true }).click()
          await page.getByRole('button', { name: /为工作台增加全局命令面板/ }).click()
          await expect(page.locator('.task-heading')).toBeVisible()
          await page.screenshot({ path: `${output}/workbench-${name}.png` })
          let inspectorColors = null
          if (preference === 'cobalt2') {
            await page.getByRole('button', { name: '打开执行检查器', exact: true }).click()
            await expect(page.locator('.inspector-surface')).toBeVisible()
            await expect(page.locator('.trace-panel')).toBeVisible()
            await expect(page.locator('.inspector-tabs')).toHaveCSS('background-color', 'rgb(25, 53, 73)')
            await expect(page.locator('.trace-panel')).toHaveCSS('background-color', 'rgb(21, 35, 45)')
            inspectorColors = await page.evaluate(() => Object.fromEntries(['inspector-tabs', 'trace-panel'].map(name => [name, getComputedStyle(document.querySelector('.' + name)).backgroundColor])))
            await page.screenshot({ path: `${output}/workbench-inspector-${name}.png` })
            await page.getByRole('button', { name: '收起检查器', exact: true }).click()
            await expect(page.locator('.inspector-surface')).toBeHidden()
          }
          await page.getByRole('button', { name: '创建任务', exact: true }).click()
          await expect(page.getByRole('dialog')).toBeVisible()
          const dialogColor = await page.locator('[data-slot=dialog-content]').evaluate(el => getComputedStyle(el).backgroundColor)
          expect(dialogColor).toBe(menuColor)
          const primaryButtonColors = await page.getByRole('dialog').locator('[data-slot=button][data-variant=default]').first().evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))
          if (preference === 'cobalt2') {
            expect(primaryButtonColors.background).toBe('rgb(255, 198, 0)')
            expect(contrast(primaryButtonColors.color, primaryButtonColors.background), 'Rendered Cobalt2 primary button contrast').toBeGreaterThanOrEqual(4.5)
          }
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toBeHidden()
          let destructiveButtonColors = null
          if (preference === 'cobalt2') {
            await page.locator('.task-heading').getByRole('button', { name: /^删除任务：/ }).click()
            const deleteDialog = page.getByRole('dialog', { name: '删除任务？', exact: true })
            await expect(deleteDialog).toBeVisible()
            const destructiveButton = deleteDialog.getByRole('button', { name: '删除任务', exact: true })
            await expect(destructiveButton).toBeEnabled()
            const normal = await destructiveButton.evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))
            expect(normal.background).toBe('rgb(255, 160, 188)')
            expect(contrast(normal.color, normal.background), 'Rendered Cobalt2 destructive button contrast').toBeGreaterThanOrEqual(4.5)
            await destructiveButton.hover()
            await expect.poll(() => destructiveButton.evaluate(el => el.getAnimations().length)).toBe(0)
            const hover = await destructiveButton.evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))
            expect(hover.background).not.toBe(normal.background)
            expect(contrast(hover.color, hover.background), 'Hovered Cobalt2 destructive button contrast').toBeGreaterThanOrEqual(4.5)
            destructiveButtonColors = { normal, hover }
            await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
            await expect(deleteDialog).toBeHidden()
            await expect(page.locator('.task-heading').getByRole('button', { name: /^删除任务：/ })).toBeFocused()
          }
          await appearance()
          surfaces.push({ preference, colorScheme, colors, menuColor, dialogColor, primaryButtonColors, destructiveButtonColors, inspectorColors, contrastRatios, piPixels })
        }

        await pick('跟随系统')
        await page.emulateMedia({ colorScheme: 'light' })
        await saved('light', 'system')
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
        await expect(page.getByRole('option', { name: 'Cobalt2', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(picker).toBeFocused()
        await expect(picker).toContainText('Cobalt2')
        await saved('cobalt2', 'cobalt2')

        // Inspect reversal at 5x the normal feedback duration. Browser scheduling
        // under concurrent smoke load must not consume the entire 200 ms probe.
        // The normal-duration entrance/exit checks above still use production CSS.
        if (reducedMotion === 'no-preference') await page.evaluate(() => document.documentElement.style.setProperty('--motion-theme-duration', '1s'))
        // Keyboard selections can reverse an active palette transition without
        // waiting for its feedback or storage confirmation to finish.
        async function paletteSample() {
          return page.locator('.titlebar').evaluate(el => {
            const style = getComputedStyle(el)
            const picker = document.querySelector('#app-theme')
            return {
              theme: document.documentElement.dataset.theme,
              background: style.backgroundColor,
              transform: style.transform,
              titlebarRect: el.getBoundingClientRect().toJSON(),
              pickerRect: picker.getBoundingClientRect().toJSON(),
              animations: el.getAnimations().map(animation => ({
                property: animation.transitionProperty,
                currentTime: animation.currentTime,
                playState: animation.playState,
                keyframes: animation.effect.getKeyframes(),
              })),
            }
          })
        }
        const initialPaletteSample = await paletteSample()
        const paletteReversalSamples = []
        let currentPaletteLabel = 'Cobalt2'
        for (const [preference, label] of [['dark', '深色'], ['cobalt2', 'Cobalt2'], ['dark', '深色'], ['cobalt2', 'Cobalt2']]) {
          await picker.press('Space')
          await expect(page.getByRole('option', { name: currentPaletteLabel, exact: true })).toBeFocused()
          await page.keyboard.press(preference === 'cobalt2' ? 'End' : 'Home')
          if (preference === 'dark') {
            await expect(page.getByRole('option', { name: '跟随系统', exact: true })).toBeFocused()
            await page.keyboard.press('ArrowDown')
          }
          await expect(page.getByRole('option', { name: label, exact: true })).toBeFocused()
          const before = await paletteSample()
          await page.keyboard.press('Enter')
          await expect(root).toHaveAttribute('data-theme', preference)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
          const after = await paletteSample()
          expect(after.transform).toBe('none')
          expect(after.titlebarRect).toEqual(initialPaletteSample.titlebarRect)
          expect(after.pickerRect).toEqual(initialPaletteSample.pickerRect)
          paletteReversalSamples.push({ preference, before, after })
          currentPaletteLabel = label
        }
        if (reducedMotion === 'no-preference') {
          expect(paletteReversalSamples.some(sample => sample.before.animations.some(animation => animation.property === 'background-color' && animation.playState === 'running')), 'A Cobalt2/Dark choice interrupts a live background transition').toBe(true)
          expect(paletteReversalSamples.some(sample => sample.after.animations.some(animation => animation.property === 'background-color' && animation.currentTime !== null)), 'Palette colors animate while layout stays fixed').toBe(true)
        } else {
          for (const sample of paletteReversalSamples) expect(sample.after.animations).toEqual([])
        }
        await saved('cobalt2', 'cobalt2')
        if (reducedMotion === 'no-preference') await page.evaluate(() => document.documentElement.style.removeProperty('--motion-theme-duration'))
        await expect(picker).toContainText('Cobalt2')
        await pick('浅色')
        await expect(picker).toContainText('浅色')
        await saved('light', 'light')
        const storedName = await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.runtimes[0].name)
        await page.getByRole('button', { name: '运行时', exact: true }).click()
        await page.getByLabel('名称', { exact: true }).fill('Unsaved runtime name')
        await page.getByRole('button', { name: '外观', exact: true }).click()
        await page.evaluate(() => {
          const original = Storage.prototype.setItem
          window.restoreThemeStorage = () => { Storage.prototype.setItem = original }
          Storage.prototype.setItem = function(key, value) {
            if (key === 'goalward.preview.v1') throw new Error('Theme smoke storage unavailable')
            return original.call(this, key, value)
          }
        })
        await pick('Cobalt2')
        await expect(page.getByRole('alert').filter({ hasText: '自动保存失败' }).first()).toBeVisible()
        await expect(root).toHaveAttribute('data-theme', 'light')
        await expect(picker).toContainText('浅色')
        await page.evaluate(() => { window.restoreThemeStorage(); delete window.restoreThemeStorage })
        await page.getByRole('button', { name: '重试', exact: true }).click()
        await expect(root).toHaveAttribute('data-theme', 'cobalt2')
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.theme)).toBe('cobalt2')
        await expect(page.getByText('外观已自动保存 · 其他设置有未保存的更改', { exact: true })).toBeVisible()
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.runtimes[0].name)).toBe(storedName)
        await page.getByRole('button', { name: '运行时', exact: true }).click()
        await expect(page.getByLabel('名称', { exact: true })).toHaveValue('Unsaved runtime name')
        await page.getByRole('button', { name: '还原', exact: true }).click()
        await page.getByRole('button', { name: '外观', exact: true }).click()
        await expect(picker).toContainText('Cobalt2')
        await page.getByRole('button', { name: '返回工作台', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await page.reload()
        await expect(root).toHaveAttribute('data-theme', 'cobalt2')
        expect(errors).toEqual([])
        results.push({ width, height, reducedMotion, initialSystem, savedAndReloaded: true, followsSystemLive: true, explicitOverride: true, immediateApply: true, automaticSave: true, runtimeDraftIsolated: true, saveFailureRetry: true, saveFailureRollback: true, keyboardFocus: true, menuEntrance, menuExit, menuReopen, surfaces, reversalSamples: samples, paletteReversalSamples, errors })
        console.log(`PASS theme ${width}x${height} ${reducedMotion} OS ${initialSystem}`)
        await context.close()
      }
    }
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  console.log(`PASS ${results.length} theme scenarios; screenshots in ${output}`)
} finally { await browser.close() }
