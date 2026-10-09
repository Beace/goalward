import { chromium, expect } from '@playwright/test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/inspector-resize'
await mkdir(output, { recursive:true })
const fixture = JSON.parse(await readFile('test-results/artifacts/fixture-state.json', 'utf8'))
const browser = await chromium.launch({ channel:'chrome', headless:true })
const results = []
try {
  for (const width of [1536, 1280, 1180]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport:{width,height:width === 1536 ? 960:720},reducedMotion })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(state => { if (window === window.top) localStorage.setItem('goalward.preview.v1',JSON.stringify(state)) },fixture)
    await page.goto('http://127.0.0.1:1420')
    await page.locator('.task-nav-item').filter({hasText:fixture.tasks[0].title}).click()
    await page.getByRole('tab',{name:'产物 3',exact:true}).click()
    await page.getByRole('button',{name:'预览 report.html',exact:true}).click()
    const surface = page.locator('#execution-inspector')
    const size = async () => (await surface.boundingBox()).width
    const settled = () => expect(page.locator('[data-inspector-motion]')).toHaveAttribute('data-inspector-motion','idle')
    await settled()
    const handle = page.getByRole('separator',{name:width < 1280 ? '调整产物与执行面板宽度':'调整执行检查器宽度',exact:true})
    const start = await size()
    let box = await handle.boundingBox(); const y = box.y + 180, x = box.x + box.width/2
    await handle.evaluate(el => el.addEventListener('pointerdown', e => {window.__resizePointer=e.pointerId}, {once:true}))
    await page.mouse.move(x,y);await page.mouse.down()
    const steps = []
    for (const delta of [50,170,230]) {
      await page.mouse.move(x-delta,y)
      const actual = await surface.evaluate(el => new Promise(resolve => requestAnimationFrame(() => resolve(el.getBoundingClientRect().width))))
      expect(Math.abs(actual-start-delta), JSON.stringify({width,reducedMotion,delta,start,actual})).toBeLessThan(3)
      steps.push({delta,actual})
    }
    await page.mouse.up();await settled()
    const resized = await size();expect(resized).toBeGreaterThan(480)
    const tabs = page.getByRole('tablist',{name:'右侧工具面板'})
    await tabs.getByRole('tab',{name:'执行过程',exact:true}).click()
    expect(Math.abs(await size()-resized)).toBeLessThan(2)
    await tabs.getByRole('tab',{name:'产物预览',exact:true}).click()
    await page.getByRole('button',{name:'收起检查器',exact:true}).click();await settled()
    await page.locator('[data-inspector-toggle]').click();await settled()
    expect(Math.abs(await size()-resized)).toBeLessThan(2)
    // Reach the window-dependent maximum, substantially beyond the old 480px cap.
    box = await handle.boundingBox()
    await page.mouse.move(box.x+box.width/2,y);await page.mouse.down();await page.mouse.move(240,y,{steps:8});await page.mouse.up();await settled()
    const maximum = await size()
    expect(maximum).toBeGreaterThan(width === 1536 ? 850 : 650)
    await expect(page.getByRole('button',{name:'收起检查器',exact:true})).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({path:`${output}/wide-${width}-${reducedMotion}.png`})
    // Cancel while held, then move further: a cancelled gesture must not resume.
    box = await handle.boundingBox();const cancelX=box.x+box.width/2
    await handle.evaluate(el => el.addEventListener('pointerdown', e => {window.__resizePointer=e.pointerId}, {once:true}))
    await page.mouse.move(cancelX,y);await page.mouse.down();await page.mouse.move(cancelX+40,y)
    await handle.evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:window.__resizePointer,pointerType:'mouse'})))
    const cancelled = await size();await page.mouse.move(cancelX+100,y);expect(Math.abs(await size()-cancelled)).toBeLessThan(2)
    await page.mouse.up();await settled()
    await handle.focus();await page.keyboard.press('ArrowRight');await expect.poll(size).toBeLessThan(cancelled)
    await page.keyboard.press('ArrowLeft');await settled()
    // A remembered wide panel must fit after switching to the compact layout.
    await page.setViewportSize({width:1100,height:720})
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await settled()
    if (await page.locator('[data-inspector-toggle]').getAttribute('aria-expanded') === 'false') await page.locator('[data-inspector-toggle]').click()
    await settled()
    const compact = await surface.boundingBox()
    const root = await page.locator('.inspector-layout').boundingBox()
    expect(compact.x).toBeGreaterThanOrEqual(root.x-1)
    expect(compact.x+compact.width).toBeLessThanOrEqual(1101)
    await expect(page.getByRole('button',{name:'收起检查器',exact:true})).toBeInViewport()
    expect(errors).toEqual([])
    results.push({width,reducedMotion,start,steps,resized,maximum,compactWidth:compact.width,pointerCancel:true,keyboard:true,retainedAcrossTabsAndReopen:true,errors})
    await page.close()
  }
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
} finally {await browser.close()}
