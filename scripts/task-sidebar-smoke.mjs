import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/task-sidebar'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = []
try {
 for (const [width,height] of [[1536,960],[1280,720]]) for (const reducedMotion of ['no-preference','reduce']) {
  const context = await browser.newContext({ viewport:{width,height}, reducedMotion })
  const page=await context.newPage()
  const errors=[]; page.on('pageerror', error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:1420')
  await page.evaluate(async()=>{
   const {createInitialState}=await import('/src/lib/domain.ts')
   const {createWorkspaceTask}=await import('/src/lib/workspace.ts')
   const state=createInitialState()
   state.tasks=Array.from({length:24},(_,i)=>createWorkspaceTask(state.settings,{title:i===0?'岛台石材选择':i===1?'生成一篇如何做好业务品质的 HTML 文档与完整验收记录':`任务 ${i+1}`,directory:'/tmp'}))
   state.tasks[1].businessStatus='blocked'
   state.tasks[0].messages=[{id:'message-fixture',role:'user',text:'帮我比较三种石材的效果',createdAt:state.tasks[0].createdAt}]
   state.activeTaskId=state.tasks[0].id
   state.onboarding={version:1,completedAt:new Date().toISOString(),outcome:'configured'}
   localStorage.setItem('goalward.preview.v1',JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^任务\s*\d+$/}).click()
  const list=page.getByRole('complementary',{name:'任务列表'})
  await expect(list).toBeVisible()
  await expect(page.locator('[data-task-heading]')).toHaveText('岛台石材选择')
  await expect(list.getByRole('button',{name:'打开任务：岛台石材选择'})).toHaveAttribute('aria-pressed','true')
  await page.getByRole('button',{name:'收起检查器',exact:true}).click()
  await expect(page.locator('.inspector-layout')).toHaveAttribute('data-inspector-motion','idle')
  await page.screenshot({path:`${output}/overview-${width}-${reducedMotion}.png`})
  await page.locator('[data-inspector-toggle]').click()
  const search=list.getByRole('textbox',{name:'搜索全部任务'})
  await search.fill('业务品质')
  await list.getByRole('button',{name:/打开任务：生成/}).click()
  await expect(page.locator('[data-task-heading]')).toContainText('业务品质')
  await expect(search).toHaveValue('业务品质')
  await search.fill('不存在的任务')
  await expect(list.getByText('没有匹配的任务')).toBeVisible()
  await list.getByRole('button',{name:'清除筛选'}).first().click()
  await expect(list.getByRole('button',{name:/打开任务：/})).toHaveCount(24)
  await list.getByRole('button',{name:'筛选任务',exact:true}).click()
  await page.getByRole('combobox',{name:'筛选任务状态'}).click()
  await page.getByRole('option',{name:'受阻',exact:true}).click()
  await page.keyboard.press('Escape')
  await expect(list.getByRole('button',{name:'筛选任务',exact:true})).toBeFocused()
  await expect(list.getByRole('button',{name:/打开任务：/})).toHaveCount(1)
  await list.getByRole('button',{name:'清除筛选'}).click()
  await list.getByRole('button',{name:'打开任务：岛台石材选择'}).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-task-heading]')).toHaveText('岛台石材选择')
  const handle=page.getByRole('separator',{name:'调整任务列表宽度'})
  const before=(await list.boundingBox()).width
  await handle.focus(); await page.keyboard.press('ArrowRight')
  await expect.poll(async()=>(await list.boundingBox()).width).toBeGreaterThan(before)
  const box=await handle.boundingBox()
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+36,box.y+box.height/2)
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  const remembered=(await list.boundingBox()).width
  await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^目标/}).click()
  await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^任务\s*\d+$/}).click()
  assert(Math.abs((await list.boundingBox()).width-remembered)<2)
  for(const row of await list.getByRole('button',{name:/打开任务：/}).all()) assert.equal((await row.boundingBox()).height,40)
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await expect(page.getByRole('textbox',{name:'任务指令'})).toBeInViewport()
  await page.screenshot({path:`${output}/${width}-${reducedMotion}.png`})
  if ((await page.locator('.inspector-layout').boundingBox()).width < 760) {
   await expect(page.locator('#execution-inspector')).toHaveClass(/inspector-floating/)
   await page.getByRole('button',{name:'收起检查器',exact:true}).focus()
   await page.keyboard.press('Escape')
   await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
   await expect(page.locator('#execution-inspector')).toHaveAttribute('aria-hidden','true')
  }
  assert.deepEqual(errors,[])
  report.push({width,height,reducedMotion,search:true,filters:true,selection:true,keyboard:true,resize:true,cancel:true,widthMemory:true,rows:40,overflow:false})
  await context.close()
 }
 await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close()}
