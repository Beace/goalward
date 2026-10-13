import { chromium, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const baseUrl = process.env.GOALWARD_SMOKE_URL || 'http://127.0.0.1:1420'
const output = 'test-results/background-settings'
const databaseName = 'goalward.appearance-images.v1'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
const alpha = color => color === 'transparent' ? 0 : color.includes('/') ? Number(color.match(/\/\s*([\d.]+)/)?.[1]) : color.startsWith('rgba(') ? Number(color.match(/,\s*([\d.]+)\)$/)?.[1]) : 1
const longName = 'Long background image filename for truncation and complete button targets — café-Ångström-'.repeat(3) + '.png'

async function settings(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings) }
async function enterAppearance(page) {
  if (!await page.locator('.settings-page').isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await expect(page.getByRole('region', { name: '背景图', exact: true })).toBeVisible()
}
async function assertSaved(page, patch, dirty = false) {
  await expect.poll(async () => { const current = await settings(page); return Object.fromEntries(Object.keys(patch).map(key => [key, current[key]])) }).toEqual(patch)
  await expect(page.getByText(dirty ? '外观已自动保存 · 其他设置有未保存的更改' : '外观已自动保存', { exact: true })).toBeVisible()
}
async function setOpacity(page, label, value, key, dirty = false) {
  const slider = page.getByRole('slider', { name: label, exact: true })
  if (value === 100) await slider.press('End')
  else {
    await slider.press('Home')
    for (let step = 0; step < Math.floor(value / 10); step++) await slider.press('Shift+ArrowRight')
    for (let step = 0; step < value % 10; step++) await slider.press('ArrowRight')
  }
  await expect(slider).toHaveAttribute('aria-valuenow', String(value))
  await expect(slider).toHaveAttribute('aria-valuetext', `${value}%`)
  await expect(slider).toBeFocused()
  await assertSaved(page, { [key]: value }, dirty)
}
async function snapshot(page, selectors) {
  return page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`Missing surface: ${selector}`)
    const css = getComputedStyle(element)
    return [selector, { background: css.backgroundColor, opacity: css.opacity, transition: css.transitionProperty, animations: element.getAnimations().map(animation => animation.transitionProperty), rect: element.getBoundingClientRect().toJSON() }]
  })), selectors)
}
function expectAlpha(surfaces, wanted) {
  for (const [selector, style] of Object.entries(surfaces)) {
    expect(alpha(style.background), `${selector}: ${style.background}`).toBeCloseTo(wanted, 3)
    expect(style.opacity, `${selector} foreground opacity`).toBe('1')
  }
}
async function geometry(page) {
  const sizes = await page.evaluate(() => {
    const image = document.querySelector('.app-background img')
    const layer = image?.parentElement
    const footer = document.querySelector('.settings-page main > footer')
    return {
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      layerRect: layer?.getBoundingClientRect().toJSON(), imageRect: image?.getBoundingClientRect().toJSON(),
      fit: image && getComputedStyle(image).objectFit, position: layer && getComputedStyle(layer).position,
      pointer: layer && getComputedStyle(layer).pointerEvents, layerOpacity: layer && getComputedStyle(layer).opacity,
      imageOpacity: image && getComputedStyle(image).opacity, footerRect: footer?.getBoundingClientRect().toJSON(),
      foregroundOpacity: getComputedStyle(document.querySelector('.app-shell')).opacity,
      imageInterceptsPointer: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.app-background') !== null,
    }
  })
  expect(sizes.overflow).toBe(false)
  expect(sizes.position).toBe('fixed')
  expect(sizes.pointer).toBe('none')
  expect(sizes.fit).toBe('cover')
  expect(sizes.foregroundOpacity).toBe('1')
  expect(sizes.layerOpacity).toBe('1')
  expect(sizes.imageInterceptsPointer).toBe(false)
  expect(sizes.layerRect).toMatchObject({ x: 0, y: 0, width: sizes.width, height: sizes.height })
  expect(sizes.imageRect).toMatchObject({ x: 0, y: 0, width: sizes.width, height: sizes.height })
  if (sizes.footerRect) expect(sizes.footerRect.bottom).toBeLessThanOrEqual(sizes.height)
  return sizes
}
async function mutateAsset(page, path, operation, bytes) {
  await page.evaluate(async ({ databaseName, path, operation, bytes }) => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open(databaseName, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('images', 'readwrite')
      transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error)
      const store = transaction.objectStore('images')
      if (operation === 'delete') store.delete(path)
      else store.put(new Blob([new Uint8Array(bytes)], { type: 'image/png' }), path)
    })
    database.close()
  }, { databaseName, path, operation, bytes })
}
async function injectSaveFailure(page) {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    window.restoreBackgroundSmokeStorage = () => { Storage.prototype.setItem = original; delete window.restoreBackgroundSmokeStorage }
    Storage.prototype.setItem = function(key, value) { if (key === 'goalward.preview.v1') throw new Error('Background smoke storage unavailable'); return original.call(this, key, value) }
  })
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion, colorScheme: 'dark' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let run = { width, height, reducedMotion, scenarios: [], errors }
    try {
      await page.goto(baseUrl)
      run.media = await page.evaluate(() => ({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches, increasedContrast: matchMedia('(prefers-contrast: more)').matches }))
      expect(run.media.reducedMotion).toBe(reducedMotion === 'reduce')
      const generatedFixture = await page.evaluate(async () => {
        const { createInitialState } = await import('/src/lib/domain.ts')
        const state = createInitialState()
        state.settings.theme = 'dark'
        state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
        localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
        const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 960
        const paint = canvas.getContext('2d')
        paint.fillStyle = '#466777'; paint.fillRect(0, 0, 1536, 960)
        paint.fillStyle = '#8197a0'; paint.fillRect(0, 0, 1536, 400)
        paint.fillStyle = '#d2b68b'; paint.beginPath(); paint.moveTo(0, 960); paint.lineTo(1536, 150); paint.lineTo(1536, 960); paint.fill()
        paint.strokeStyle = '#d5ded9'; paint.lineWidth = 3
        for (let x = 0; x < 1536; x += 96) { paint.beginPath(); paint.moveTo(x, 0); paint.lineTo(x, 960); paint.stroke() }
        return canvas.toDataURL('image/png').split(',')[1]
      })
      const buffer = process.env.GOALWARD_BACKGROUND_FIXTURE ? await readFile(process.env.GOALWARD_BACKGROUND_FIXTURE) : Buffer.from(generatedFixture, 'base64')
      await writeFile(`${output}/fixture-${width}-${reducedMotion}.png`, buffer)
      const file = { name: longName, mimeType: 'image/png', buffer }
      await page.reload()
      await enterAppearance(page)
      await expect(page.getByRole('slider', { name: '背景图不透明度', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByRole('slider', { name: '界面背景不透明度', exact: true })).toHaveAttribute('aria-disabled', 'true')
      const backgroundRegion = page.getByRole('region', { name: '背景图', exact: true })
      await expect(backgroundRegion.getByRole('spinbutton')).toHaveCount(0)
      await expect(backgroundRegion.locator('input[type=number], output')).toHaveCount(0)
      expect(await backgroundRegion.evaluate(element => [...element.querySelectorAll('span')].some(span => span.textContent.trim() === '%'))).toBe(false)
      run.sliderOnlyControls = true
      await page.getByLabel('背景图片文件', { exact: true }).setInputFiles(file)
      await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready')
      const selected = (await settings(page)).backgroundImage
      expect(selected.name).toBe(longName)
      expect(selected.path).toMatch(/^preview-background:/)
      expect(JSON.stringify(await settings(page))).not.toMatch(/data:image|base64|image\/png/)
      // An empty browser picker result must retain the current selection.
      await page.getByLabel('背景图片文件', { exact: true }).setInputFiles([])
      expect((await settings(page)).backgroundImage).toEqual(selected)
      run.browserCancellationRetainsImage = true
      const row = await page.getByText(longName, { exact: true }).evaluate(element => {
        const parent = element.parentElement
        return { width: element.clientWidth, fullWidth: element.scrollWidth, overflow: getComputedStyle(element).textOverflow, line: getComputedStyle(element).whiteSpace, title: element.title, rowHeight: parent.getBoundingClientRect().height, buttons: [...parent.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON()) }
      })
      expect(row.title).toBe(longName); expect(row.overflow).toBe('ellipsis'); expect(row.line).toBe('nowrap'); expect(row.fullWidth).toBeGreaterThan(row.width); expect(row.rowHeight).toBe(40)
      for (const button of row.buttons) { expect(button.height).toBeGreaterThanOrEqual(28); expect(button.width).toBeGreaterThanOrEqual(28) }
      run.longFilename = row

      for (const [theme, label] of [['dark', '深色'], ['light', '浅色'], ['cobalt2', 'Cobalt2']]) {
        const picker = page.getByRole('combobox', { name: '界面主题', exact: true })
        await picker.click(); await page.getByRole('option', { name: label, exact: true }).click(); await expect(picker).toBeFocused()
        await assertSaved(page, { theme }); await expect(page.locator('html')).not.toHaveClass(/theme-changing/)
        await setOpacity(page, '背景图不透明度', 0, 'backgroundImageOpacity')
        await expect(page.locator('.app-background img')).toHaveCSS('opacity', '0')
        await setOpacity(page, '背景图不透明度', 100, 'backgroundImageOpacity')
        await expect(page.locator('.app-background img')).toHaveCSS('opacity', '1')
        const settingsSelectors = ['.settings-page > header', '.settings-page > div > nav', '.settings-page > div > main > [data-slot=scroll-area]', '.settings-page main > footer']
        const opacitySamples = []
        for (const value of [0, 100, 35]) {
          await setOpacity(page, '界面背景不透明度', value, 'backgroundSurfaceOpacity')
          const surfaces = await snapshot(page, settingsSelectors); expectAlpha(surfaces, value / 100)
          expectAlpha(await snapshot(page, ['.settings-page', '.settings-page main']), 0)
          opacitySamples.push({ value, surfaces })
        }
        const imageSlider = page.getByRole('slider', { name: '背景图不透明度', exact: true })
        await imageSlider.focus(); await imageSlider.press('Home'); await assertSaved(page, { backgroundImageOpacity: 0 }); await expect(imageSlider).toBeFocused()
        await imageSlider.press('End'); await assertSaved(page, { backgroundImageOpacity: 100 })
        const surfaceSlider = page.getByRole('slider', { name: '界面背景不透明度', exact: true })
        await surfaceSlider.focus(); await surfaceSlider.press('Home'); await assertSaved(page, { backgroundSurfaceOpacity: 0 })
        await surfaceSlider.press('End'); await assertSaved(page, { backgroundSurfaceOpacity: 100 })
        await expect(surfaceSlider).toBeFocused()
        await surfaceSlider.scrollIntoViewIfNeeded()
        const trackBox = await surfaceSlider.evaluate(thumb => thumb.closest('[data-slot=slider]').querySelector('[data-slot=slider-track]').getBoundingClientRect().toJSON())
        const pointerSamples = []
        await page.mouse.move(trackBox.x + trackBox.width - 2, trackBox.y + trackBox.height / 2); await page.mouse.down()
        for (const fraction of [0.72, 0.32, 0.57]) {
          await page.mouse.move(trackBox.x + trackBox.width * fraction, trackBox.y + trackBox.height / 2)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
          const sample = await surfaceSlider.evaluate(thumb => ({ value: Number(thumb.getAttribute('aria-valuenow')), alpha: getComputedStyle(document.querySelector('.settings-page main > [data-slot=scroll-area]')).backgroundColor, thumbTransitions: getComputedStyle(thumb).transitionProperty, activeAnimations: thumb.getAnimations().map(animation => animation.transitionProperty) }))
          expect(alpha(sample.alpha)).toBeCloseTo(sample.value / 100, 3); expect(Math.abs(sample.value - Math.round(fraction * 100))).toBeLessThanOrEqual(3)
          expect(sample.activeAnimations).toEqual([])
          pointerSamples.push(sample)
        }
        await page.mouse.up()
        await surfaceSlider.evaluate(thumb => {
          const root = thumb.closest('[data-slot=slider]')
          const probe = { root, events: [], target: undefined, pointerId: undefined }
          const listener = event => {
            probe.events.push({ type: event.type, trusted: event.isTrusted, pointerType: event.pointerType, pointerId: event.pointerId })
            if (event.type === 'pointerdown') { probe.target = event.target; probe.pointerId = event.pointerId }
          }
          probe.listener = listener
          for (const event of ['pointerdown', 'pointercancel', 'lostpointercapture']) root.addEventListener(event, listener)
          window.backgroundCancellationProbe = probe
        })
        const touch = await context.newCDPSession(page)
        const touchPoint = fraction => ({ x: trackBox.x + trackBox.width * fraction, y: trackBox.y + trackBox.height / 2, id: 1 })
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(0.25)] })
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(0.61)] })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
        const beforeCancel = Number(await surfaceSlider.getAttribute('aria-valuenow'))
        expect(beforeCancel).toBeGreaterThan(55); expect(beforeCancel).toBeLessThan(65)
        await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        await page.mouse.move(trackBox.x + trackBox.width * 0.1, trackBox.y + trackBox.height / 2)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
        const cancellation = await surfaceSlider.evaluate(thumb => {
          const probe = window.backgroundCancellationProbe
          for (const event of ['pointerdown', 'pointercancel', 'lostpointercapture']) probe.root.removeEventListener(event, probe.listener)
          const result = { events: probe.events, capturedAfterCancel: probe.target.hasPointerCapture(probe.pointerId), value: Number(thumb.getAttribute('aria-valuenow')), surface: getComputedStyle(document.querySelector('.settings-page main > [data-slot=scroll-area]')).backgroundColor, animations: thumb.getAnimations().map(animation => animation.transitionProperty) }
          delete window.backgroundCancellationProbe
          return result
        })
        expect(cancellation.events.some(event => event.type === 'pointercancel' && event.trusted && event.pointerType === 'touch')).toBe(true)
        expect(cancellation.events.some(event => event.type === 'lostpointercapture' && event.trusted)).toBe(true)
        expect(cancellation.capturedAfterCancel).toBe(false); expect(cancellation.value).toBe(beforeCancel)
        expect(alpha(cancellation.surface)).toBeCloseTo(beforeCancel / 100, 3); expect(cancellation.animations).toEqual([])
        await surfaceSlider.press('ArrowRight'); await expect(surfaceSlider).toBeFocused()
        await assertSaved(page, { backgroundSurfaceOpacity: beforeCancel + 1 })
        await touch.detach()
        await setOpacity(page, '界面背景不透明度', 55, 'backgroundSurfaceOpacity')
        await picker.click(); await expect(page.getByRole('listbox')).toBeVisible()
        await expect(page.locator('[data-slot=select-content]')).toHaveCSS('opacity', '1')
        const menu = await snapshot(page, ['[data-slot=select-content]']); expectAlpha(menu, 1)
        await page.keyboard.press('Escape'); await expect(picker).toBeFocused()
        await page.getByRole('combobox', { name: '界面字体', exact: true }).click()
        await expect(page.locator('[data-slot=popover-content]')).toHaveCSS('opacity', '1')
        const popover = await snapshot(page, ['[data-slot=popover-content]']); expectAlpha(popover, 1)
        await page.keyboard.press('Escape'); await expect(page.getByRole('combobox', { name: '界面字体', exact: true })).toBeFocused()
        expectAlpha(await snapshot(page, ['#app-theme']), 1)
        const thumbSurfaces = await snapshot(page, ['[data-slot=slider-thumb] > span']); expectAlpha(thumbSurfaces, 1)
        const settingsGeometry = await geometry(page)
        await page.locator('.settings-page main > [data-slot=scroll-area] [data-slot=scroll-area-viewport]').evaluate(viewport => { viewport.scrollTop = 0 })
        await page.screenshot({ path: `${output}/appearance-${width}-${reducedMotion}-${theme}.png` })
        await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready'); await enterAppearance(page)
        expect((await settings(page)).backgroundImage).toEqual(selected)
        await expect(page.getByRole('slider', { name: '界面背景不透明度', exact: true })).toHaveAttribute('aria-valuenow', '55')
        await expect(page.getByRole('slider', { name: '界面背景不透明度', exact: true })).toHaveAttribute('aria-valuetext', '55%')
        await page.getByRole('button', { name: '返回工作台', exact: true }).click()
        await page.getByRole('button', { name: /为工作台增加全局命令面板/ }).click()
        await expect(page.locator('.workbench')).toBeVisible()
        await page.getByRole('button', { name: '打开执行检查器', exact: true }).click()
        await expect(page.locator('.trace-panel')).toBeVisible()
        await expect(page.locator('.main-panes')).toHaveAttribute('data-inspector-motion', 'idle')
        const workbenchSurfaces = await snapshot(page, ['.sidebar', '.workbench', '.trace-panel', '.titlebar', '.inspector-tabs-heading']); expectAlpha(workbenchSurfaces, 0.55)
        expectAlpha(await snapshot(page, ['.inspector-tabs', '.main-panes']), 0)
        const workbenchGeometry = await geometry(page)
        expect(workbenchSurfaces['.workbench'].rect.right).toBeLessThanOrEqual(workbenchSurfaces['.trace-panel'].rect.x + 1)
        await page.screenshot({ path: `${output}/workbench-trace-${width}-${reducedMotion}-${theme}.png` })
        await page.getByRole('button', { name: '创建任务', exact: true }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.locator('[data-slot=dialog-content]')).toHaveCSS('opacity', '1')
        const dialog = await snapshot(page, ['[data-slot=dialog-content]', '#task-title', '[data-slot=dialog-content] [data-slot=button][data-variant=default]']); expectAlpha(dialog, 1)
        // Dark outline buttons already use bg-input/30. Their authored color
        // must remain unchanged while app surfaces move between 0 and 100%.
        const outline = await page.locator('[data-slot=dialog-content] [data-slot=button][data-variant=outline]').evaluate(button => {
          const root = document.documentElement; const original = root.style.getPropertyValue('--app-surface-opacity')
          root.style.setProperty('--app-surface-opacity', '0%'); const atZero = getComputedStyle(button).backgroundColor
          root.style.setProperty('--app-surface-opacity', '100%'); const atFull = getComputedStyle(button).backgroundColor
          root.style.setProperty('--app-surface-opacity', original)
          return { atZero, atFull, opacity: getComputedStyle(button).opacity }
        })
        expect(outline.atZero).toBe(outline.atFull); expect(outline.opacity).toBe('1'); expect(alpha(outline.atFull)).toBe(theme === 'light' ? 1 : 0.3)
        await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeHidden()
        await page.getByRole('button', { name: '收起检查器', exact: true }).click()
        await enterAppearance(page)
        run.scenarios.push({ theme, persistedReload: true, opacitySamples, pointerSamples, cancellation, keyboard: true, menu, popover, dialog, outline, thumbSurfaces, settingsGeometry, workbenchSurfaces, workbenchGeometry })
        console.log(`PASS background ${width}x${height} ${reducedMotion} ${theme}`)
      }

      // Appearance saves preserve unrelated Runtime drafts, including rollback/retry.
      const runtimeName = (await settings(page)).runtimes[0].name
      await page.getByRole('button', { name: '运行时', exact: true }).click(); await page.getByLabel('名称', { exact: true }).fill('Background smoke unsaved Runtime')
      await enterAppearance(page)
      await injectSaveFailure(page)
      await page.getByLabel('背景图片文件', { exact: true }).setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer })
      await expect(page.getByRole('alert').filter({ hasText: '自动保存失败' }).first()).toBeVisible()
      await expect(page.getByText(longName, { exact: true })).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready')
      expect((await settings(page)).backgroundImage).toEqual(selected)
      await page.evaluate(() => window.restoreBackgroundSmokeStorage())
      await page.locator('.settings-page main > footer').getByRole('button', { name: '重试', exact: true }).click()
      await expect(page.getByText('replacement.png', { exact: true })).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready')
      const replaced = (await settings(page)).backgroundImage
      expect(replaced.path).not.toBe(selected.path)
      await assertSaved(page, { backgroundImage: replaced }, true)
      await injectSaveFailure(page)
      // One real keyboard event produces one failed save, avoiding repeated
      // errors from a multi-step adjustment while persistence is unavailable.
      await page.getByRole('slider', { name: '背景图不透明度', exact: true }).press('Home')
      await expect(page.getByRole('alert').filter({ hasText: '自动保存失败' }).first()).toBeVisible()
      await expect(page.getByRole('slider', { name: '背景图不透明度', exact: true })).toHaveAttribute('aria-valuenow', '100')
      await expect(page.locator('.app-background img')).toHaveCSS('opacity', '1')
      await page.evaluate(() => window.restoreBackgroundSmokeStorage())
      await page.locator('.settings-page main > footer').getByRole('button', { name: '重试', exact: true }).click()
      await assertSaved(page, { backgroundImageOpacity: 0 }, true)
      await expect(page.locator('.app-background img')).toHaveCSS('opacity', '0')
      await setOpacity(page, '背景图不透明度', 64, 'backgroundImageOpacity', true)
      await setOpacity(page, '界面背景不透明度', 42, 'backgroundSurfaceOpacity', true)
      expect((await settings(page)).runtimes[0].name).toBe(runtimeName)
      const retainedOldImage = await page.evaluate(async image => { const { loadBackgroundImage } = await import('/src/lib/background-image.ts'); const src = await loadBackgroundImage(image); const img = new Image(); img.src = src; await img.decode(); URL.revokeObjectURL(src); return img.naturalWidth > 0 }, selected)
      expect(retainedOldImage).toBe(true)
      await page.getByRole('button', { name: '运行时', exact: true }).click(); await expect(page.getByLabel('名称', { exact: true })).toHaveValue('Background smoke unsaved Runtime')
      await page.getByRole('button', { name: '还原', exact: true }).click(); await enterAppearance(page)
      run.runtimeDraftPreserved = true; run.saveFailureRollbackRetry = true; run.oldAssetRetained = retainedOldImage

      // OS accessibility preferences override translucency without mutating stored choices.
      const accessibility = []
      await page.emulateMedia({ contrast: 'more' })
      await expect(page.locator('.app-background')).toBeHidden()
      const contrastSurfaces = await snapshot(page, ['.settings-page > header', '.settings-page > div > main > [data-slot=scroll-area]']); expectAlpha(contrastSurfaces, 1)
      accessibility.push({ preference: 'contrast-more', surfaces: contrastSurfaces })
      await page.emulateMedia({ contrast: 'no-preference' })
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: reducedMotion }] })
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
      await expect(page.locator('.app-background')).toBeHidden()
      const transparencySurfaces = await snapshot(page, ['.settings-page > header', '.settings-page > div > main > [data-slot=scroll-area]']); expectAlpha(transparencySurfaces, 1)
      accessibility.push({ preference: 'reduced-transparency', surfaces: transparencySurfaces })
      expect((await settings(page)).backgroundSurfaceOpacity).toBe(42)
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion }] })
      await expect(page.locator('.app-background')).toBeVisible(); run.accessibility = accessibility

      // A missing/corrupt stored Blob falls back to opaque surfaces and recovers on retry.
      for (const operation of ['delete', 'corrupt']) {
        await mutateAsset(page, replaced.path, operation === 'delete' ? 'delete' : 'put', operation === 'corrupt' ? [...buffer.subarray(0, 8), 0, 0, 0, 0] : undefined)
        await page.reload(); await enterAppearance(page)
        await expect(page.getByRole('region', { name: '背景图', exact: true }).getByRole('alert')).toBeVisible()
        await expect(page.locator('html')).not.toHaveAttribute('data-app-background', 'ready')
        expectAlpha(await snapshot(page, ['.settings-page', '.settings-page > header']), 1)
        await mutateAsset(page, replaced.path, 'put', [...buffer])
        await page.getByRole('region', { name: '背景图', exact: true }).getByRole('button', { name: '重试', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready')
        await expect(page.getByRole('region', { name: '背景图', exact: true }).getByRole('alert')).toHaveCount(0)
      }
      run.missingAndCorruptRecovery = true
      if (process.env.GOALWARD_BACKGROUND_SCREENSHOT_FIXTURE) {
        // The intentionally induced decode failure has an 8s global notice;
        // dismiss it through its real control before capturing recovered UI.
        const dismiss = page.getByRole('button', { name: '关闭提示', exact: true })
        if (await dismiss.count()) { await dismiss.click(); await expect(page.locator('.app-toast[data-front=true]')).toHaveCount(0) }
        const visualBuffer = await readFile(process.env.GOALWARD_BACKGROUND_SCREENSHOT_FIXTURE)
        await page.getByLabel('背景图片文件', { exact: true }).setInputFiles({ name: 'Example-background-Sonoma.jpg', mimeType: 'image/jpeg', buffer: visualBuffer })
        await expect(page.getByText('Example-background-Sonoma.jpg', { exact: true })).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-app-background', 'ready')
        await setOpacity(page, '背景图不透明度', 100, 'backgroundImageOpacity')
        await setOpacity(page, '界面背景不透明度', 70, 'backgroundSurfaceOpacity')
        await page.locator('.settings-page main > [data-slot=scroll-area] [data-slot=scroll-area-viewport]').evaluate(viewport => { viewport.scrollTop = 0 })
        const appearancePath = `${output}/demo-appearance-${width}-${reducedMotion}-cobalt2.png`
        await page.screenshot({ path: appearancePath })
        await page.getByRole('button', { name: '返回工作台', exact: true }).click()
        await page.getByRole('button', { name: /为工作台增加全局命令面板/ }).click()
        await page.getByRole('button', { name: '打开执行检查器', exact: true }).click(); await expect(page.locator('.trace-panel')).toBeVisible()
        await expect(page.locator('.main-panes')).toHaveAttribute('data-inspector-motion', 'idle')
        const workbenchPath = `${output}/demo-workbench-trace-${width}-${reducedMotion}-cobalt2.png`
        await page.screenshot({ path: workbenchPath })
        run.demo = { fixture: process.env.GOALWARD_BACKGROUND_SCREENSHOT_FIXTURE, imageOpacity: 100, surfaceOpacity: 70, appearancePath, workbenchPath }
        await enterAppearance(page)
      }
      await page.getByRole('button', { name: '移除背景图', exact: true }).click()
      await expect(page.locator('.app-background')).toHaveCount(0)
      await expect(page.locator('html')).not.toHaveAttribute('data-app-background', 'ready')
      await expect.poll(async () => (await settings(page)).backgroundImage).toBe(undefined)
      expectAlpha(await snapshot(page, ['.settings-page', '.settings-page > header']), 1)
      await page.reload(); await enterAppearance(page)
      await expect(page.getByRole('slider', { name: '背景图不透明度', exact: true })).toHaveAttribute('aria-disabled', 'true')
      await expect(page.locator('.app-background')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      expect(errors).toEqual([])
      run.removedAndReloadOpaque = true; run.passed = true
      results.push(run)
      await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
      console.log(`PASS background persistence/recovery ${width}x${height} ${reducedMotion}`)
    } catch (error) {
      run.passed = false; run.failure = String(error); results.push(run)
      await page.screenshot({ path: `${output}/failure-${width}-${reducedMotion}.png` }).catch(() => {})
      await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
      throw error
    } finally { await context.close() }
  }
  console.log(`PASS ${results.reduce((total, result) => total + result.scenarios.length, 0)} background theme scenarios plus ${results.length} persistence/recovery scenarios; ${output}/results.json`)
} finally { await browser.close() }
