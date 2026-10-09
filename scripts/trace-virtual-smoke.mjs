import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const dir='test-results/trace-virtual'
await mkdir(dir,{recursive:true})
await writeFile(`${dir}/harness.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>')
await writeFile(`${dir}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TracePanel} from '/src/components/TracePanel'
import {createInitialState,createTask} from '/src/lib/domain'
import '/src/index.css'
const settings=createInitialState().settings;const task=createTask(settings,'虚拟 Trace 压力验收','/tmp','solo');const member={...task.members[0],name:'Kimi CLI',status:'running',model:'',runtime:{...settings.runtimes[0],adapter:'kimi'}};task.runs=[{id:'run',createdAt:task.createdAt,prompt:'test',directory:'/tmp',members:[member]}];let count=0;
function event(payload,kind='stdout'){return {id:'event-'+(++count),kind,taskId:task.id,runId:'run',memberId:member.id,timestamp:task.createdAt,text:JSON.stringify(payload)+'\\n'}}
function chunk(){return event({type:'kimi.acp.update',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'回复片段 '+count+'\\n'}}})}
task.events=Array.from({length:10000},(_,i)=>i%100===0?event({type:'error',message:'合成错误 '+i},'stderr'):event({type:'kimi.acp.update',update:{sessionUpdate:'usage_update',index:i,content:'变长内容\\n'.repeat(i%40+1)}}));task.events.push(...Array.from({length:121},chunk));
function Harness(){const [current,setCurrent]=useState(task);window.__task=current;window.__append=(n=1)=>setCurrent(t=>({...t,events:[...t.events,...Array.from({length:n},chunk)]}));window.__resize=(width)=>document.getElementById('inspector').style.width=width+'px';return <div className="app-shell"><header className="titlebar">Goalward · 虚拟 Trace 验收（合成数据）</header><main style={{display:'flex',flex:1,minHeight:0}}><div style={{flex:1,padding:24}}>10,000 条事件 + 连续回复流<br/>动态高度 / 折叠 / 键盘 / 筛选 / 分页</div><div id="inspector" style={{display:'flex',width:420,minHeight:0}}><TracePanel task={current} run={current.runs[0]} onClose={()=>{}} onExport={()=>{}}/></div></main></div>};createRoot(document.getElementById('root')).render(<Harness/>);`)
const browser=await chromium.launch({channel:'chrome',headless:true});const report={checks:[],errors:[]}
try{for(const [width,height] of [[1536,960],[1280,720]])for(const reducedMotion of ['no-preference','reduce']){
const context=await browser.newContext({viewport:{width,height},reducedMotion});const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(`http://127.0.0.1:1420/${dir}/harness.html`)
await expect(page.getByText('10001 条记录')).toBeVisible();const viewport=page.locator('[data-slot=scroll-area-viewport]');const rows=page.locator('.virtual-list > [data-index]');const triggerAt=i=>page.locator(`[data-index="${i}"] .trace-trigger`)
const initialMounted=await rows.count();assert(initialMounted<30&&initialMounted>2)
// Dynamic height, immediate reversal, and restored expansion after unmount.
await triggerAt(1).click();await expect(triggerAt(1)).toHaveAttribute('aria-expanded','true');await triggerAt(1).click();await triggerAt(1).click();await expect(triggerAt(1)).toHaveAttribute('aria-expanded','true');await expect.poll(()=>page.locator('[data-index="1"] > .trace-event > [data-slot=collapsible-content]').getAttribute('data-collapsible-motion')).toBe('idle')
await triggerAt(1).evaluate(n=>n.blur());await viewport.evaluate(n=>{n.scrollTop=150000});await expect.poll(()=>triggerAt(1).count()).toBe(0);await viewport.evaluate(n=>{n.scrollTop=0});await expect(triggerAt(1)).toHaveAttribute('aria-expanded','true')
// Native focus is retained while a focused row is scrolled out of view.
await triggerAt(1).focus();await viewport.evaluate(n=>{n.scrollTop=150000});await expect(triggerAt(1)).toBeFocused();await triggerAt(1).evaluate(n=>n.blur());await expect.poll(()=>triggerAt(1).count()).toBe(0)
// Streaming while reading the middle of history does not move the anchor.
const before=await viewport.evaluate(n=>n.scrollTop);const stress=await page.evaluate(async()=>{const samples=[];let maxMounted=0;let previous=performance.now();for(let i=0;i<40;i++){window.__append();const v=document.querySelector('[data-slot=scroll-area-viewport]');if(i<20)v.scrollTop+=80;else v.scrollTop-=80;await new Promise(r=>requestAnimationFrame(r));const now=performance.now();samples.push(now-previous);previous=now;maxMounted=Math.max(maxMounted,document.querySelectorAll('.virtual-list > [data-index]').length)}return {frameMs:samples,maxMounted}});assert(stress.maxMounted<35)
const scroll=await viewport.evaluate(n=>n.scrollTop);await page.evaluate(()=>window.__append(10));await expect(page.getByText('10001 条记录')).toBeVisible();await page.waitForTimeout(150);assert.equal(await viewport.evaluate(n=>n.scrollTop),scroll)
// No overlapping visible rows after dynamic measurements and width changes.
await page.evaluate(()=>window.__resize(300));await page.waitForTimeout(200);const boxes=await rows.evaluateAll(nodes=>nodes.map(n=>({index:+n.dataset.index,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));for(let i=1;i<boxes.length;i++)assert(boxes[i].top>=boxes[i-1].bottom-1)
await page.evaluate(()=>window.__resize(420));await viewport.evaluate(n=>{n.scrollTop=0});await triggerAt(0).focus();await page.keyboard.press('End');await expect(triggerAt(10000)).toBeFocused();await expect(triggerAt(10000)).toBeInViewport();await expect(page.getByText('171 个片段')).toBeVisible()
await page.getByRole('button',{name:/原始记录/}).click();await page.getByRole('button',{name:'下一页'}).click();await expect(page.getByText('51–100 / 171')).toBeVisible();await triggerAt(10000).focus();await page.keyboard.press('Home');await expect(triggerAt(0)).toBeFocused();await expect.poll(()=>triggerAt(10000).count()).toBe(0);await page.keyboard.press('End');await expect(triggerAt(10000)).toBeFocused();await expect(page.getByText('51–100 / 171')).toBeVisible();assert.equal(await page.locator('.trace-raw-record').count(),50)
// Updating an expanded streaming row doesn't replay its entry or steal focus.
await page.evaluate(()=>window.__append());await expect(page.getByText('51–100 / 172')).toBeVisible();await expect(triggerAt(10000)).toBeFocused();await expect(page.locator('[data-index="10000"] > .trace-event > [data-slot=collapsible-content]')).toHaveAttribute('data-collapsible-motion','idle')
await page.getByRole('button',{name:/原始记录/}).click();await triggerAt(10000).focus();await page.keyboard.press('ArrowUp');await expect(triggerAt(9999)).toBeFocused();await page.keyboard.press('ArrowDown');await expect(triggerAt(10000)).toBeFocused()
// Filter changes reset the window rather than leaving an empty viewport at the old offset.
await page.getByRole('button',{name:'仅显示错误'}).click();await expect(page.getByText('100 条记录')).toBeVisible();await expect.poll(()=>viewport.evaluate(n=>n.scrollTop)).toBe(0);assert(await rows.count()<30);await page.getByRole('button',{name:'仅显示错误'}).click();await expect(page.getByText('10001 条记录')).toBeVisible()
await page.screenshot({path:`${dir}/trace-${width}-${reducedMotion}.png`});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));report.checks.push({width,height,reducedMotion,initialMounted,before,scroll,...stress,expansionRestored:true,rawPageRestored:true,keyboard:true,filter:true});await context.close()
}assert.deepEqual(report.errors,[]);report.status='passed'}finally{await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));await browser.close()}
console.log(JSON.stringify({...report,checks:report.checks.map(({frameMs,...r})=>({...r,frameMaxMs:Math.max(...frameMs),frameMeanMs:frameMs.reduce((a,b)=>a+b,0)/frameMs.length}))},null,2))
