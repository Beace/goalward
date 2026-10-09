import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/artifacts'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const key = 'goalward.preview.v1'
const results = []
try {
  for (const width of [1536, 1280]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width, height: width === 1536 ? 960 : 720 }, reducedMotion })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('http://127.0.0.1:1420')
    await page.waitForFunction(key => !!localStorage.getItem(key), key)
    await page.evaluate(key => {
      const state = JSON.parse(localStorage.getItem(key)); const at = '2026-09-17T09:00:00Z'
      const member = { id:'member', name:'Kimi CLI', role:'执行', runtimeId:'kimi', modelId:'' }
      const runtime = { id:'kimi',name:'Kimi CLI',executable:'kimi',adapter:'kimi',enabled:true,args:[],defaultModel:'',description:'' }
      const html = '<!doctype html><html><head><style>body{font:14px system-ui;padding:24px;color:#252820;background:#f5f3ed}h1{font-size:28px}p{line-height:1.8}section{border-top:1px solid #ccc;margin-top:24px;padding-top:16px}</style></head><body><h1>业务品质报告</h1><p>品质 = 标准 × 度量 × 闭环</p><section><h2>建立标准</h2><p>为每项业务指标明确阈值、负责人和触发动作。</p></section><section><h2>持续度量</h2><p>结合监控与用户反馈，形成可追溯的改进记录。</p></section><script>parent.__artifactEscaped = true</script></body></html>'
      const md = '# 品质执行清单\n\n| 工序 | 状态 |\n| --- | --- |\n| 建立标准 | 已完成 |\n| 回归验证 | 待执行 |\n\n- [x] 明确负责人\n- [ ] 验证结果\n\n```json\n{"quality": "tracked"}\n```'
      const task = { id:'artifact-task',title:'生成业务品质报告与执行清单',directory:'/tmp/goalward-artifacts',mode:'solo',createdAt:at,members:[member],messages:[{id:'html-message',role:'assistant',text:'```html report.html\n'+html+'\n```',createdAt:at,runId:'run',memberId:'member'},{id:'md-message',role:'assistant',text:'````markdown checklist.md\n'+md+'\n````',createdAt:at,runId:'run',memberId:'member'},{id:'file-message',role:'assistant',text:'已生成：`/tmp/goalward-artifacts/business-quality.html`',createdAt:at,runId:'run',memberId:'member'}],runs:[{id:'run',createdAt:at,directory:'/tmp/goalward-artifacts',prompt:'生成报告',members:[{...member,runtime,model:'',status:'completed'}]}],events:[],results:[],plan:[] }
      state.tasks=[task];state.goals=[];state.agents=[];state.activeTaskId=task.id;state.onboarding={version:1,completedAt:at,outcome:'configured'}
      localStorage.setItem(key,JSON.stringify(state))
    }, key)
    if (width === 1536 && reducedMotion === 'no-preference') {
      const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
      await writeFile(`${output}/fixture-state.json`, JSON.stringify(state, null, 2))
    }
    await page.reload()
    await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^任务/}).click()
    await page.getByRole('button',{name:'打开任务：生成业务品质报告与执行清单',exact:true}).click()
    await page.getByRole('tab',{name:'产物 3',exact:true}).click()
    await expect(page.locator('.artifact-row')).toHaveCount(3)
    expect(await page.locator('.artifact-row').evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height === 40))).toBe(true)
    expect(await page.locator('.artifact-row').evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect()
      const buttons = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      return buttons.every(button => button.height === 28 && button.top >= bounds.top && button.bottom <= bounds.bottom)
        && bounds.right - buttons.at(-1).right < 8
    }))).toBe(true)
    await expect(page.getByRole('heading',{name:'任务产物',exact:true})).toHaveCount(0)
    await expect(page.locator('.artifact-note')).toHaveCount(0)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const copyPath = page.getByRole('button',{name:'复制路径 business-quality.html',exact:true})
    await copyPath.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/tmp/goalward-artifacts/business-quality.html')
    await expect(page.getByRole('status').filter({hasText:'复制路径成功'})).toBeVisible()
    await page.getByRole('button',{name:'复制内容 checklist.md',exact:true}).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# 品质执行清单')
    // Metadata is available to keyboard users without adding permanent rows.
    await page.getByRole('button',{name:'business-quality.html',exact:true}).focus()
    await expect(page.getByRole('tooltip')).toContainText('/tmp/goalward-artifacts/business-quality.html')
    await expect(page.getByRole('tooltip')).toContainText('Kimi CLI · 第 1 次执行')
    await page.keyboard.press('Escape')
    await page.screenshot({path:`${output}/list-${width}-${reducedMotion}.png`})
    await page.getByRole('button',{name:'预览 report.html',exact:true}).click()
    const preview = page.getByRole('complementary',{name:'产物预览'})
    const frame = page.frameLocator('iframe[title="report.html HTML 预览"]')
    const toolbar = preview.locator('.artifact-toolbar')
    await expect(toolbar).toBeVisible()
    expect((await toolbar.boundingBox()).height).toBe(40)
    expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const controls = await toolbar.locator('button').evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().top))
    expect(Math.max(...controls) - Math.min(...controls)).toBeLessThan(2)
    await expect(toolbar.getByRole('tab',{name:'预览',exact:true})).toHaveAttribute('title','预览')

    await expect(frame.getByRole('heading',{name:'业务品质报告',exact:true})).toBeVisible()
    expect(await page.evaluate(() => window.__artifactEscaped)).toBeUndefined()
    await expect(preview.getByRole('heading',{name:'report.html',exact:true})).toBeFocused()
    await page.waitForFunction(() => document.querySelector('[data-inspector-motion]')?.dataset.inspectorMotion === 'idle')
    await page.screenshot({path:`${output}/html-${width}-${reducedMotion}.png`})
    await preview.getByRole('tab',{name:'源码',exact:true}).click()
    await expect(preview.locator('pre')).toContainText('<script>parent.__artifactEscaped')
    const tools = page.getByRole('tablist', {name:'右侧工具面板'})
    const tabBounds = await tools.locator('.inspector-tab-label').evaluateAll(items => items.map(item => {
      const tab = item.querySelector('[role=tab]').getBoundingClientRect()
      const close = item.querySelector('.inspector-tab-close').getBoundingClientRect()
      return { contained:close.left >= tab.left && close.right <= tab.right && close.top >= tab.top && close.bottom <= tab.bottom, height:tab.height }
    }))
    expect(tabBounds.every(item => item.contained && item.height === 32)).toBe(true)

    await tools.getByRole('tab', {name:'执行过程'}).click()
    await page.getByRole('button', {name:'仅显示错误'}).click()
    await tools.getByRole('tab', {name:'产物预览'}).click()
    await expect(preview.getByRole('tab', {name:'源码',exact:true})).toHaveAttribute('aria-selected','true')
    await expect(preview.locator('pre')).toContainText('<script>parent.__artifactEscaped')
    await page.keyboard.press('ArrowLeft')
    await expect(tools.getByRole('tab', {name:'执行过程'})).toBeFocused()
    await expect(page.getByRole('button', {name:'仅显示错误'})).toHaveAttribute('aria-pressed','true')
    await page.keyboard.press('ArrowRight')
    await expect(tools.getByRole('tab', {name:'产物预览'})).toBeFocused()
    await expect(preview.getByRole('tab', {name:'源码',exact:true})).toHaveAttribute('aria-selected','true')
    await page.getByRole('button',{name:'预览 checklist.md',exact:true}).click()
    await expect(preview.getByRole('table')).toBeVisible()
    await page.screenshot({path:`${output}/markdown-${width}-${reducedMotion}.png`})
    await page.getByRole('button',{name:'收起检查器',exact:true}).click()
    await page.getByRole('button',{name:'预览 report.html',exact:true}).click()
    await page.getByRole('button',{name:'收起检查器',exact:true}).click()
    await page.getByRole('button',{name:'预览 checklist.md',exact:true}).click()
    await expect(preview.getByRole('table')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
    await page.getByRole('button',{name:'预览 business-quality.html',exact:true}).click()
    await expect(preview.getByRole('alert')).toContainText('本地文件请在桌面应用中预览')
    await expect(preview.getByRole('button',{name:'复制文件内容'})).toBeDisabled()
    expect((await toolbar.boundingBox()).height).toBe(40)
    expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(toolbar.getByRole('button',{name:'Finder',exact:true})).toHaveAttribute('title','在 Finder 中显示')

    // Close an inactive tool without disturbing the current document.
    await page.getByRole('button',{name:'关闭执行过程标签',exact:true}).click()
    await expect(tools.getByRole('tab',{name:'执行过程',exact:true})).toHaveCount(0)
    await expect(preview.getByRole('alert')).toContainText('本地文件请在桌面应用中预览')
    await page.getByRole('button',{name:'关闭产物预览标签',exact:true}).click()
    await expect(page.locator('[data-inspector-toggle]')).toHaveAttribute('aria-expanded','false')
    await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
    // Explicit file opening recreates the closed preview tab.
    await page.getByRole('button',{name:'预览 report.html',exact:true}).click()
    await expect(frame.getByRole('heading',{name:'业务品质报告',exact:true})).toBeVisible()
    await expect(tools.getByRole('tab',{name:'产物预览',exact:true})).toHaveCount(1)
    await page.getByRole('tab',{name:'任务对话',exact:true}).click()
    await page.getByRole('button',{name:'查看执行',exact:true}).first().click()
    await expect(tools.getByRole('tab',{name:'执行过程',exact:true})).toHaveAttribute('aria-selected','true')
    await page.getByRole('button',{name:'关闭执行过程标签',exact:true}).click()
    await expect(tools.getByRole('tab',{name:'产物预览',exact:true})).toHaveAttribute('aria-selected','true')
    await expect(tools.getByRole('tab',{name:'产物预览',exact:true})).toBeFocused()
    await page.getByRole('button',{name:'关闭产物预览标签',exact:true}).click()
    await page.locator('[data-inspector-toggle]').click()
    await expect(tools.getByRole('tab',{name:'执行过程',exact:true})).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow).toBe(false);expect(errors).toEqual([])
    // Reload reconstructs artifacts from the retained source records.
    await page.reload()
    await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^任务/}).click()
    await page.getByRole('button',{name:'打开任务：生成业务品质报告与执行清单',exact:true}).click()
    await expect(page.getByRole('tab',{name:'产物 3',exact:true})).toBeVisible()
    results.push({width,reducedMotion,artifactRowHeight:40,copyPath:true,copyInlineContent:true,keyboardMetadata:true,html:true,markdown:true,source:true,opaqueSandbox:true,reversal:true,focus:true,error:true,inspectorTabs:true,closeInsideTabBorder:true,compactToolbarHeight:40,closeIndividualTabs:true,reopenClosedTools:true,tabStateRetained:true,keyboardTabs:true,persistence:true,overflow:false,errors})
    await page.close()
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
} finally { await browser.close() }
