import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const dir = 'test-results/trace-lazy'
const baseline = process.argv.includes('--baseline')
await mkdir(dir, { recursive: true })
await writeFile(`${dir}/harness.html`, `<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${Date.now()}"></script></body></html>`)
await writeFile(`${dir}/harness.tsx`, `import {Profiler,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '${baseline ? './WorkbenchBefore' : '/src/components/Workbench'}'
import {TracePanel} from '${baseline ? './TracePanelBefore' : '/src/components/TracePanel'}'
import {createInitialState,createTask} from '/src/lib/domain'
import {getTaskArtifacts} from '/src/lib/artifacts'
import '/src/index.css'
const settings=createInitialState().settings;const task=createTask(settings,'执行过程加载与对话性能验收','/tmp','solo');
task.messages=Array.from({length:8},(_,i)=>({id:'reply-'+i,role:'assistant',createdAt:task.createdAt,text:('# 回复 '+i+'\\n\\n'+('段落 **强调** [报告](./report.md) 和代码。\\n\\n').repeat(18))}));
const member={...task.members[0],status:'running',runtime:{...settings.runtimes[0],adapter:'codex'},model:''};task.runs=[{id:'run',createdAt:task.createdAt,prompt:'test',directory:'/tmp',members:[member]}];let n=0;
function event(){return {id:'event-'+(++n),taskId:task.id,runId:'run',memberId:member.id,timestamp:task.createdAt,kind:'stdout',text:JSON.stringify({type:'item.completed',item:{id:'tool-'+n,type:'mcp_tool_call',server:'fixture',tool:'read',result:{content:'原始内容'.repeat(300)}}})+'\\n'}}
task.events=Array.from({length:1000},event);window.__durations=[];
function Harness(){const [current,setCurrent]=useState(task);window.__append=()=>setCurrent(t=>({...t,events:[...t.events,event()]}));return <div className="app-shell"><main style={{display:'flex',flex:1,minHeight:0}}><div style={{flex:1,minWidth:0}}><Workbench task={current} settings={settings} artifacts={getTaskArtifacts(current)} selectedRunId="" onSelectRun={()=>{}} onChange={()=>{}} onSend={async()=>{}} onStop={()=>{}} onSettings={()=>{}} onInspector={()=>{}} inspectorOpen={true} onDuplicate={()=>{}} onOpenArtifact={a=>{window.__artifact=a}}/></div><div style={{display:'flex',width:336,minHeight:0}}><TracePanel task={current} run={current.runs[0]} onClose={()=>{}} onExport={()=>{}}/></div></main></div>}
createRoot(document.getElementById('root')).render(<Profiler id="workbench" onRender={(_id,_phase,duration)=>window.__durations.push(duration)}><Harness/></Profiler>);`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = { scope: 'Synthetic events in real Workbench + TracePanel; no native runtime', baseline, checks: [], errors: [] }
try {
  for (const [width, height, reducedMotion] of [[1536, 960, 'no-preference'], [1280, 720, 'reduce']]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion })
    page.on('pageerror', error => report.errors.push(error.message))
    await page.goto(`http://127.0.0.1:1420/${dir}/harness.html`)
    await expect(page.getByText('1000 条记录')).toBeVisible()
    if (!baseline) assert.equal(await page.locator('.trace-detail').count(), 0)
    await page.evaluate(() => {
      window.__mutations=0;window.__durations=[];
      window.__observer=new MutationObserver(records=>window.__mutations+=records.length);
      document.querySelectorAll('.markdown-body').forEach(node=>window.__observer.observe(node,{subtree:true,childList:true}));
      const chat=document.querySelector('.chat-scroll');chat.scrollTop=100;chat.dispatchEvent(new Event('scroll',{bubbles:true}));
    })
    const frames = await page.evaluate(async () => {
      const samples=[];
      for(let i=0;i<35;i++) {const start=performance.now();window.__append();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));samples.push(performance.now()-start)}
      return samples;
    })
    const measurements = await page.evaluate(() => ({ mutations:window.__mutations, durations:window.__durations, scrollTop:document.querySelector('.chat-scroll').scrollTop }))
    if (!baseline) assert.equal(measurements.mutations, 0, 'Trace-only updates must not rebuild unchanged Markdown')
    assert.equal(measurements.scrollTop, 100)
    const input=page.getByRole('textbox', {name:'任务指令'})
    await page.evaluate(() => { window.__streamTimer=setInterval(()=>window.__append(),30) })
    await input.pressSequentially('持续输出时继续输入',{delay:20})
    await expect(input).toHaveValue('持续输出时继续输入')
    await page.evaluate(() => clearInterval(window.__streamTimer))
    const trigger=page.locator('.trace-trigger').first()
    await trigger.click();await expect(trigger).toHaveAttribute('aria-expanded','true')
    await expect(page.getByRole('region',{name:'出参'})).toBeVisible()
    await trigger.click();await trigger.click();await expect(trigger).toHaveAttribute('aria-expanded','true')
    await trigger.click()
    if(!baseline) await expect(page.locator('.trace-detail')).toHaveCount(0)
    await trigger.focus();await page.keyboard.press('Enter');await expect(trigger).toHaveAttribute('aria-expanded','true')
    await page.keyboard.press('Enter');await expect(trigger).toHaveAttribute('aria-expanded','false');await expect(trigger).toBeFocused()
    await page.screenshot({path:dir+'/'+(baseline?'before':'after')+'-'+width+'.png'})
    report.checks.push({width,height,reducedMotion,...measurements,frameMaxMs:Math.max(...frames),frameMeanMs:frames.reduce((a,b)=>a+b)/frames.length})
    if(!baseline) {
      const fixture=await page.evaluate(async()=>{
        const {createInitialState,createTask}=await import('/src/lib/domain.ts');
        const state=createInitialState();const task=createTask(state.settings,'按需加载测试任务','/tmp','solo');
        state.tasks=[task];state.activeTaskId=task.id;
        task.messages=[{id:'reply',role:'assistant',text:'[报告](./report.md)',createdAt:task.createdAt}];
        const member={...task.members[0],status:'completed',model:'',runtime:state.settings.runtimes[0]};
        task.runs=[{id:'run',createdAt:task.createdAt,prompt:'fixture',directory:'/tmp',members:[member]}];
        task.events=[{id:'done',taskId:task.id,runId:'run',memberId:member.id,kind:'completed',timestamp:task.createdAt,text:'done'}];
        return state;
      })
      await page.evaluate(state=>localStorage.setItem('goalward.preview.v1',JSON.stringify(state)),fixture)
      const requests=[];page.on('request',request=>requests.push(request.url()))
      await page.goto('http://127.0.0.1:1420/')
      await page.locator('.task-nav-item').filter({hasText:'按需加载测试任务'}).click()
      await expect(page.getByRole('heading',{name:'按需加载测试任务',exact:true})).toBeVisible()
      await expect(page.locator('[data-inspector-toggle]')).toHaveAttribute('aria-expanded','false')
      assert.equal(await page.locator('.trace-panel').count(),0)
      assert(!requests.some(url=>url.includes('/components/TracePanel.tsx')), 'Trace UI must not load before requested')
      await page.getByRole('button',{name:'打开执行检查器',exact:true}).click()
      await expect(page.locator('.trace-panel')).toBeVisible()
      assert(requests.some(url=>url.includes('/components/TracePanel.tsx')))
      await expect(page.locator('.trace-trigger')).toHaveAttribute('aria-expanded','false')
      await page.getByRole('tab',{name:'产物预览',exact:true}).click()
      await expect(page.locator('.trace-panel')).toHaveCount(0)
      await page.getByRole('tab',{name:'执行过程',exact:true}).click()
      await expect(page.locator('.trace-panel')).toBeVisible()
      await page.getByRole('button',{name:'收起检查器',exact:true}).click()
      await expect(page.locator('.trace-panel')).toHaveCount(0)
      await expect(page.locator('[data-inspector-toggle]')).toBeFocused()
      report.checks.at(-1).appLazyLoad=true
    }
    await page.close()
  }
  assert.deepEqual(report.errors,[])
  report.status='passed'
} finally {await writeFile(dir+'/'+(baseline?'before':'after')+'.json',JSON.stringify(report,null,2));await browser.close()}
console.log(JSON.stringify(report,null,2))
