import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const output = 'test-results/conversation'
const base = process.env.CONVERSATION_SMOKE_URL ?? 'http://127.0.0.1:1420'
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, `<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${Date.now()}"></script></body></html>`)
await writeFile(`${output}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '/src/components/Workbench'
import {Button} from '/src/components/ui/button'
import {createInitialState,createTask,applyRuntimeEvent} from '/src/lib/domain'
import '/src/index.css'
const initial=createInitialState()
const task=createTask(initial.settings,'同一轮回答合并预览','/tmp','solo')
const member=task.members[0]
task.runs=[{id:'run',createdAt:task.createdAt,prompt:'整理新闻',directory:'/tmp',members:[{...member,runtime:initial.settings.runtimes[0],model:'',status:'running'}]}]
task.messages=[{id:'user',role:'user',runId:'run',createdAt:task.createdAt,text:'获取昨日的 AI 相关新闻，整理成一个本地 HTML 文件'}]
const seed={...initial,tasks:[task]}
let sequence=0
function Harness(){
 const [state,setState]=useState(seed)
 const [selected,setSelected]=useState('run')
 const [inspector,setInspector]=useState(false)
 const append=(text)=>setState(current=>applyRuntimeEvent(current,{id:'event-'+(++sequence),taskId:task.id,runId:'run',memberId:member.id,timestamp:new Date().toISOString(),kind:'stdout',text:JSON.stringify({type:'item.completed',item:{id:'part-'+sequence,type:'agent_message',text}})+'\\n'}))
 window.__append=append
 window.__complete=()=>setState(current=>applyRuntimeEvent(current,{id:'done',taskId:task.id,runId:'run',memberId:member.id,timestamp:new Date().toISOString(),kind:'completed',text:''}))
 return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><div style={{display:'flex',gap:12,padding:8,alignItems:'center'}}><span>合成数据 · 同一轮多段回复</span><Button onClick={()=>append('这是同一轮新增的一段公开回答。')}>追加一段</Button><Button onClick={()=>window.__complete()}>结束执行</Button><span>{inspector?'已请求查看执行':''}</span></div><div style={{flex:1,minHeight:0}}><Workbench task={state.tasks[0]} settings={state.settings} selectedRunId={selected} onSelectRun={setSelected} onChange={()=>{}} onSend={async()=>{}} onStop={()=>{}} onSettings={()=>{}} onInspector={()=>setInspector(true)} inspectorOpen={inspector} onDuplicate={()=>{}}/></div></div>
}
createRoot(document.getElementById('root')!).render(<Harness/> )
`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = { scenarios: [], errors: [] }
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    await page.goto(`${base}/${output}/harness.html`)
    await expect(page.getByRole('heading', { name: '同一轮回答合并预览' })).toBeVisible()
    await page.evaluate(() => window.__append('我会按北京时间整理昨日的 AI 新闻，核对新闻日期和来源，生成带摘要、要点与原文链接的本地 HTML 文件。'))
    const reply = page.locator('.message-assistant')
    await expect(reply).toHaveCount(1)
    await reply.evaluate(node => { window.__reply = node; window.__part = node.querySelector('.message-part') })
    await page.evaluate(() => window.__append('我会制作便于阅读和打印的日报页面。检索时会特别核对时区：海外媒体标注的日期，换算成北京时间可能已经是次日。'))
    await expect(reply.locator('.message-part')).toHaveCount(2)
    await expect(reply.locator('.message-heading')).toHaveCount(1)
    await expect(reply.locator('.message-foot')).toHaveCount(1)
    assert(await reply.evaluate(node => node === window.__reply && node.querySelector('.message-part') === window.__part))
    assert(await reply.evaluate(node => node.getAnimations({ subtree: false }).length === 0))
    await expect(reply.locator('.message-foot')).toContainText('正在执行')
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}.png` })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await reply.getByRole('button', { name: '查看执行' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('已请求查看执行')).toBeVisible()
    if (reducedMotion === 'reduce') assert.equal(await reply.locator('.animate-spin').evaluate(node => getComputedStyle(node).animationName), 'none')
    await page.evaluate(() => window.__append(Array.from({length:60},(_,i)=>'新闻条目 '+i+'：用于检查长回答的滚动位置。').join('\n\n')))
    const scroll = page.getByLabel('任务对话记录')
    await expect.poll(() => scroll.evaluate(node => node.scrollHeight-node.scrollTop-node.clientHeight)).toBeLessThan(5)
    await scroll.evaluate(node => {node.scrollTop=100; node.dispatchEvent(new Event('scroll'))})
    await expect(page.getByRole('button',{name:'回到最新'})).toBeVisible()
    const top = await scroll.evaluate(node=>node.scrollTop)
    await page.evaluate(() => window.__append('后续追加内容。\n\n'.repeat(20)))
    await expect(reply.locator('.message-part')).toHaveCount(4)
    assert.equal(await scroll.evaluate(node=>node.scrollTop), top)
    await page.getByRole('button',{name:'回到最新'}).click()
    await expect.poll(() => scroll.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)).toBeLessThan(5)
    await page.evaluate(() => window.__complete())
    await expect(reply.locator('.message-foot')).toContainText('Runtime 输出')
    await expect(reply.locator('.animate-spin')).toHaveCount(0)
    report.scenarios.push({width,height,reducedMotion,oneReply:true,stableDOM:true,scrollPreserved:true,keyboardEntry:true,noOverflow:true})
    await context.close()
  }
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
