import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const output = 'test-results/reasoning-stream'
const base = process.env.REASONING_SMOKE_URL ?? 'http://127.0.0.1:1420'
const harnessVersion = Date.now()
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, `<!doctype html><html class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${harnessVersion}"></script></body></html>`)
await writeFile(`${output}/harness.tsx`, `
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '/src/components/Workbench'
import {TracePanel} from '/src/components/TracePanel'
import {applyRuntimeEvent,createInitialState,createTask} from '/src/lib/domain'
import '/src/index.css'
let sequence=0
const initial=createInitialState()
const task=createTask(initial.settings,'思考流合并验收','/tmp/reasoning-stream','solo')
const member=task.members[0]
const runtime={...initial.settings.runtimes.find(item=>item.adapter==='claude'),id:'claude',adapter:'claude',enabled:true}
task.runs=[{id:'run',createdAt:task.createdAt,prompt:'test',directory:task.directory,members:[{...member,runtime,model:'claude',status:'running'}]}]
let seed={...initial,tasks:[task],activeTaskId:task.id}
const event=(payload,kind='stdout')=>({id:'event-'+(++sequence),taskId:task.id,runId:'run',memberId:member.id,timestamp:new Date(Date.parse(task.createdAt)+sequence*4).toISOString(),kind,text:kind==='stdout'?JSON.stringify(payload)+'\\n':''})
const stream=payload=>event({type:'stream_event',event:payload,session_id:'session',parent_tool_use_id:null})
seed=applyRuntimeEvent(seed,stream({type:'message_start',message:{id:'message-thinking',role:'assistant',content:[]}}))
seed=applyRuntimeEvent(seed,stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}}))
function Harness(){
 const [state,setState]=useState(seed)
 const current=state.tasks[0]
 window.__appendThinking=(text,tokens)=>setState(value=>[stream({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:text}}),event({type:'system',subtype:'thinking_tokens',estimated_tokens:tokens,estimated_tokens_delta:1,session_id:'session'})].reduce(applyRuntimeEvent,value))
 window.__startAnswer=()=>setState(value=>[
   stream({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'private-signature'}}),
   stream({type:'content_block_stop',index:0}),
   stream({type:'content_block_start',index:1,content_block:{type:'text',text:''}}),
 ].reduce(applyRuntimeEvent,value))
 window.__appendAnswer=text=>setState(value=>applyRuntimeEvent(value,stream({type:'content_block_delta',index:1,delta:{type:'text_delta',text}})))
 window.__finishAnswer=answer=>setState(value=>[
   stream({type:'content_block_stop',index:1}),
   stream({type:'message_stop'}),
   event({type:'assistant',message:{id:'message-thinking',content:[{type:'thinking',thinking:'先检查上下文，再形成结论。'},{type:'text',text:answer}]},session_id:'session'}),
   event({type:'result',subtype:'success',result:answer,session_id:'session'}),
   event(null,'completed'),
 ].reduce(applyRuntimeEvent,value))
 return <div style={{height:'100vh',display:'grid',gridTemplateColumns:'minmax(0,1fr) 380px'}}>
   <Workbench task={current} settings={state.settings} selectedRunId="run" onSelectRun={()=>{}} onChange={()=>{}} onSend={async()=>{}} onStop={()=>{}} onSettings={()=>{}} onInspector={()=>{}} inspectorOpen onDuplicate={()=>{}}/>
   <div id="inspector" style={{minWidth:0,borderLeft:'1px solid var(--color-border)'}}><TracePanel task={current} run={current.runs[0]} onClose={()=>{}} onExport={()=>{}}/></div>
 </div>
}
createRoot(document.getElementById('root')).render(<Harness/>)
`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = { status: 'running', scope: 'Real Workbench and TracePanel in isolated browser state; synthetic Claude frames matching the captured protocol shape.', scenarios: [], errors: [] }
try {
  for (const [width, height, reducedMotion] of [[1536, 960, 'no-preference'], [1280, 720, 'reduce']]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    await page.goto(`${base}/${output}/harness.html?v=${harnessVersion}`)
    await page.waitForFunction(() => typeof window.__startAnswer === 'function')
    await page.evaluate(() => window.__appendThinking('先检查上下文，', 5))
    const article = page.locator('.message-assistant')
    const disclosure = article.getByRole('button', { name: /思考过程/ })
    const reasoningRow = page.locator('.trace-event[data-reasoning-status]')
    await expect(article).toHaveCount(1)
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(article.getByLabel('思考过程')).toContainText('先检查上下文，')
    await expect(article.locator('.message-foot')).toContainText('正在思考…')
    await expect(reasoningRow).toHaveCount(1)
    await expect(reasoningRow).toHaveAttribute('data-reasoning-status', 'running')
    const reasoningTrigger = reasoningRow.locator('.trace-trigger')
    if (await reasoningTrigger.getAttribute('aria-expanded') !== 'true') await reasoningTrigger.click()
    await article.evaluate(node => { window.__article = node })
    await disclosure.evaluate(node => { window.__disclosure = node })
    await reasoningRow.evaluate(node => { window.__reasoningRow = node; window.__reasoningTrigger = node.querySelector('.trace-trigger') })
    for (let index = 6; index <= 24; index++) await page.evaluate(([text, tokens]) => window.__appendThinking(text, tokens), [index === 24 ? '再形成结论。' : '', index])
    await expect(article.getByLabel('思考过程')).toContainText('先检查上下文，再形成结论。')
    await expect(reasoningRow.getByText(/24 tokens/)).toBeVisible()
    assert(await article.evaluate(node => node === window.__article && node.querySelector('.reasoning-trigger') === window.__disclosure))
    assert(await reasoningRow.evaluate(node => node === window.__reasoningRow && node.querySelector('.trace-trigger') === window.__reasoningTrigger))
    await page.evaluate(() => window.__startAnswer())
    await page.evaluate(() => window.__appendAnswer('这'))
    const messageRow = page.locator('.trace-event[data-message-status]')
    await expect(messageRow).toHaveCount(1)
    await messageRow.evaluate(node => { window.__messageRow = node })
    await page.evaluate(() => window.__appendAnswer('是公开'))
    await page.evaluate(() => window.__appendAnswer('回答。'))
    await expect(messageRow).toHaveCount(1)
    await expect(messageRow).toContainText('这是公开回答。')
    assert(await messageRow.evaluate(node => node === window.__messageRow))
    await page.evaluate(() => window.__finishAnswer('这是公开回答。'))
    await expect(article.getByText('这是公开回答。')).toBeVisible()
    await expect(article.locator('.message-foot')).toContainText('Runtime 输出')
    await expect(reasoningRow).toHaveAttribute('data-reasoning-status', 'completed')
    await expect(page.locator('.trace-event[data-reasoning-status]')).toHaveCount(1)
    await expect(messageRow).toHaveCount(1)
    await expect(messageRow).toHaveAttribute('data-message-status', 'completed')
    await expect(page.locator('.trace-event').filter({ has: page.locator('.trace-event-title strong', { hasText: /^生成回复$/ }) })).toHaveCount(1)
    assert(await messageRow.evaluate(node => node === window.__messageRow))
    const messageTrigger = messageRow.locator('.trace-trigger')
    if (await messageTrigger.getAttribute('aria-expanded') !== 'true') await messageTrigger.click()
    await expect(messageRow.getByLabel('回复内容', { exact: true })).toHaveText('这是公开回答。')
    await expect(messageRow.getByText(/8 个原始记录/)).toBeVisible()
    await expect(reasoningRow.getByText(/思考内容/)).toBeVisible()
    await expect(reasoningRow).not.toContainText('private-signature')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}.png`, fullPage: true })
    report.scenarios.push({ width, height, reducedMotion, oneConversationTurn: true, oneReasoningRow: true, oneMessageRowPerIndex: true, stableCenterDOM: true, stableInspectorDOM: true, stableMessageDOM: true, messageRawRecords: 8, tokenCount: 24, signatureHiddenFromPresentation: true, noOverflow: true })
    await context.close()
  }
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
