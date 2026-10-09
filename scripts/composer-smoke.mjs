import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/composer'
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=' + Date.now() + '"></script></body></html>')
await writeFile(`${output}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '/src/components/Workbench'
import {createInitialState,createTask} from '/src/lib/domain'
import '/src/index.css'
const initial=createInitialState(); const settings=initial.settings
settings.models=[{id:'astra',name:'GPT-6-Astra',modelId:'gpt-6-astra',runtimeIds:['codex'],enabled:true,providerId:'',reasoningEffort:'high'},{id:'other',name:'GPT 5.5',modelId:'gpt-5.5',runtimeIds:['codex'],enabled:true,providerId:'',reasoningEffort:'low'}]
const task=createTask(settings,'输入区交互验收','/tmp','team');task.members=[{id:'lead',name:'Codex',role:'协调者',runtimeId:'codex',modelId:'gpt-6-astra'},{id:'review',name:'Codex',role:'审查',runtimeId:'codex',modelId:'gpt-5.5'}]
function Harness(){const [current,setCurrent]=useState(task);const [selected,setSelected]=useState('');window.__task=current;window.__setTask=setCurrent;window.__setSelected=setSelected;window.__settings=settings;return <div className="app-shell"><header className="titlebar">Goalward · 输入区交互验收（合成数据）</header><div style={{display:'flex',flex:1,minHeight:0}}><aside style={{width:224,flexShrink:0,borderRight:'1px solid #2e3231',padding:16}}>工作空间<br/>任务 / 输入区交互验收</aside><div style={{flex:1,minWidth:0,minHeight:0}}><Workbench task={current} settings={settings} selectedRunId={selected} onSelectRun={setSelected} onChange={setCurrent} onSend={(prompt,recipient)=>{window.__sent={prompt,recipient};return new Promise((resolve,reject)=>{window.__resolve=resolve;window.__reject=reject})}} onStop={()=>{}} onSettings={()=>{window.__settingsOpened=true}} onInspector={()=>{}} inspectorOpen={true} onDuplicate={()=>{}}/></div><aside style={{width:336,flexShrink:0,borderLeft:'1px solid #2e3231',padding:16}}>执行过程</aside></div></div>};createRoot(document.getElementById('root')).render(<Harness/> )`)
const browser = await chromium.launch({ channel:'chrome', headless:true })
const report = {checks:[], errors:[]}
try {
 for (const [width,height] of [[1536,960],[1280,720]]) for (const reducedMotion of ['no-preference','reduce']) {
  const context=await browser.newContext({viewport:{width,height},reducedMotion});const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message))
  await page.goto(`http://127.0.0.1:1420/${output}/harness.html`)
  const trigger=page.getByRole('button',{name:/^消息接收者：/});const input=page.getByRole('textbox',{name:'任务指令'});const send=page.getByRole('button',{name:'发送指令',exact:true})
  await expect(send).toBeDisabled();await expect(input).toBeInViewport()
  await trigger.click();const menu=page.getByRole('dialog',{name:'接收者与模型配置'});await expect(menu).toBeVisible();await expect(menu).toHaveCSS('opacity','1')
  const runtimeSelect=menu.getByRole('combobox',{name:'协调者 Runtime'});await expect(runtimeSelect).toBeVisible()
  assert(await runtimeSelect.evaluate(node=>Boolean(node.closest('.recipient-members'))))
  assert.equal(await menu.locator('.recipient-models .recipient-runtime-picker').count(),0)
  await page.screenshot({path:`${output}/menu-${width}-${reducedMotion}.png`})
  const rect=await menu.boundingBox();assert(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=width)
  await page.getByRole('button',{name:'审查',exact:true}).click();await expect(trigger).toContainText('审查')
  await page.getByRole('button',{name:'选择模型 GPT-6-Astra',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.__task.members[1].modelId)).toBe('gpt-6-astra')
  const effort=page.getByRole('combobox',{name:'审查 · GPT-6-Astra 思考强度'});await effort.click();await page.getByRole('option',{name:'超高 · xhigh',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.__task.members[1].reasoningEffort)).toBe('xhigh')
  await page.keyboard.press('Escape');await expect(trigger).toBeFocused()
  // Interrupt the actual opacity transition, inspect retained paint-only exit.
  await trigger.click();await page.keyboard.press('Escape')
  const exit=await page.evaluate(()=>{const node=document.querySelector('[data-dialog-exit="popover"]');return node?{inert:node.inert,animations:node.getAnimations().length}:null})
  if(reducedMotion==='reduce') assert.equal(exit,null);else if(exit) assert(exit.inert&&exit.animations>0)
  await trigger.click();await expect(menu).toBeVisible();await page.keyboard.press('Escape');await expect(trigger).toBeFocused()
  // Management remains independent of send target.
  await trigger.click();await page.getByRole('button',{name:'所有成员',exact:true}).click();await page.getByRole('button',{name:'成员与 Runtime',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'成员与 Runtime',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(trigger).toContainText('所有成员')
  await input.fill('第一条指令');await input.press('Enter');await expect(input).toHaveValue('第一条指令\n');await input.press('Meta+Enter')
  await expect.poll(()=>page.evaluate(()=>window.__sent)).toEqual({prompt:'第一条指令',recipient:'all'})
  await input.fill('发送等待时写的新草稿');await page.evaluate(()=>window.__resolve());await expect(input).toHaveValue('发送等待时写的新草稿')
  await send.click();await page.evaluate(()=>window.__reject(new Error('合成发送失败')));await expect(page.getByRole('alert')).toContainText('合成发送失败');await expect(input).toHaveValue('发送等待时写的新草稿')
  await input.fill('长草稿\n'.repeat(50));assert((await input.boundingBox()).height<=240);await expect(send).toBeInViewport()
  await page.getByRole('button',{name:'关闭发送错误'}).click();await input.fill('请检查最近的变更，先给出实施计划。');await page.waitForFunction(()=>!document.querySelector('[data-dialog-exit]'));await page.screenshot({path:`${output}/composer-${width}-${reducedMotion}.png`})
  await page.evaluate(()=>window.__setTask(t=>({...t,runs:[{id:'active',createdAt:t.createdAt,prompt:'进行中',directory:t.directory,members:t.members.map(m=>({...m,runtime:window.__settings.runtimes.find(r=>r.id===m.runtimeId),model:m.modelId,status:'running',effectiveReasoningEffort:'low'}))}]})))
  await expect(send).toBeDisabled();await input.fill('下一条草稿');await trigger.click();await page.getByRole('button',{name:'协调者',exact:true}).click();await page.getByRole('button',{name:'选择模型 GPT 5.5',exact:true}).click()
  await expect(menu).toContainText('配置更改下次执行生效');assert.equal(await page.evaluate(()=>window.__task.runs[0].members[0].modelId),'gpt-6-astra')
  await page.keyboard.press('Escape');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  report.checks.push({width,height,reducedMotion,runtimeInLeftColumn:true,recipientModelEffort:true,keyboardFocus:true,sendDraftPreserved:true,runSnapshotPreserved:true,overflow:false,exit})
  await page.evaluate(()=>{window.__setTask(t=>({...t,runs:[{...t.runs[0],id:'old',members:t.runs[0].members.map(m=>({...m,status:'completed'}))},{...t.runs[0],id:'latest',members:t.runs[0].members.map(m=>({...m,status:'completed'}))}]}));window.__setSelected('old')})
  await expect(input).toBeDisabled();await expect(send).toBeDisabled();await trigger.click();await expect(menu).toContainText('历史配置只读');await expect(menu.getByRole('combobox').first()).toBeDisabled();await page.keyboard.press('Escape')
  // Real App shell with an isolated browser store, no native runtime invocation.
  await page.evaluate(()=>localStorage.setItem('goalward.preview.v1',JSON.stringify({version:2,goals:[],agents:[],settings:window.__settings,tasks:[{...window.__task,runs:[]}],activeTaskId:window.__task.id})))
  await page.goto('http://127.0.0.1:1420');await page.getByRole('button',{name:/输入区交互验收/}).first().click()
  await expect(input).toBeVisible();await input.fill('对照最新设计，检查输入区域的交互。');await page.screenshot({path:`${output}/app-${width}-${reducedMotion}.png`})
  await trigger.click();await expect(menu).toBeVisible();await expect(menu).toHaveCSS('opacity','1');await page.screenshot({path:`${output}/app-menu-${width}-${reducedMotion}.png`});await page.keyboard.press('Escape')
  await page.getByRole('button',{name:'设置',exact:true}).click();await expect(page.getByRole('heading',{name:'Codex',exact:true})).toBeVisible();await page.screenshot({path:`${output}/settings-${width}-${reducedMotion}.png`})
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await context.close()
 }
 assert.deepEqual(report.errors,[]);report.status='passed';console.log(JSON.stringify(report,null,2))
}finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await browser.close()}
