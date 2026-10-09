import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const output = 'test-results/image-preview'
await mkdir(output, { recursive: true })
const imageSource='data:image/png;base64,'+(await readFile(process.argv[2] || 'assets/branding/goalward-icon.png')).toString('base64')
await writeFile(`${output}/harness.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>')
await writeFile(`${output}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '/src/components/Workbench'
import {createInitialState,createTask} from '/src/lib/domain'
import {promptWithAttachments} from '/src/lib/attachments'
import '/src/index.css'
const {settings}=createInitialState(); const task=createTask(settings,'图片预览验证','/tmp','solo');
const file={name:'截图-20260917-222501.png',path:'/Users/example/Library/Application Support/dev.goalward.desktop/attachments/uuid/截图-20260917-222501.png'};
task.messages=[{id:'old-message',role:'user',text:promptWithAttachments('图片里有什么',[file]),createdAt:task.createdAt}];
function Harness(){const [current,setCurrent]=useState(task);return <div className="app-shell"><header className="titlebar">Goalward · 图片预览验证（模拟 IPC）</header><div style={{display:'flex',flex:1,minHeight:0}}><aside style={{width:224,flexShrink:0,padding:16,borderRight:'1px solid var(--color-border)'}}>任务</aside><div id="workbench-pane" style={{flex:1,minWidth:0,minHeight:0}}><Workbench task={current} settings={settings} selectedRunId="" onSelectRun={()=>{}} onChange={setCurrent} onSend={async(prompt,recipient)=>{window.__sent={prompt,recipient};setCurrent(t=>({...t,messages:[...t.messages,{id:crypto.randomUUID(),role:'user',text:prompt,createdAt:new Date().toISOString()}]}))}} onStop={()=>{}} onSettings={()=>{}} onInspector={()=>{}} inspectorOpen={true} onDuplicate={()=>{}}/></div><aside style={{width:336,flexShrink:0,padding:16,borderLeft:'1px solid var(--color-border)'}}>执行过程</aside></div></div>}; createRoot(document.getElementById('root')).render(<Harness/>);`)
// A standalone browser demo, with the same explicit simulated IPC boundary as the tests.
await writeFile(`${output}/demo.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script>window.isTauri=true;window.__TAURI_INTERNALS__={invoke:async(command)=>{if(command==="read_attachment_image")return '+JSON.stringify(imageSource)+';if(command==="read_clipboard_attachments")return [{name:"截图.png",path:"/tmp/截图.png"}];throw new Error(command)}};</script><script type="module" src="./harness.tsx"></script></body></html>')
const browser=await chromium.launch({channel:'chrome',headless:true})
const report={scope:'Actual browser image decoding and interactions with simulated native IPC; native file read tested in Rust.',checks:[],errors:[]}
try {
 for (const [width,height] of [[1536,960],[1280,720]]) for(const reducedMotion of ['no-preference','reduce']) {
  const context=await browser.newContext({viewport:{width,height},reducedMotion})
  await context.addInitScript(imageSource=>{
   window.isTauri=true;window.__imageError=false
   window.__TAURI_INTERNALS__={invoke:async(command)=>{
    if(command==='read_attachment_image'){if(window.__imageError)throw new Error('图片不存在或无法访问');return imageSource}
    if(command==='read_clipboard_attachments')return [{name:'待发送截图.png',path:'/tmp/待发送截图.png'}]
    throw new Error(command)
   }}
  },imageSource)
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message))
  await page.goto(`http://127.0.0.1:1420/${output}/harness.html`)
  const oldImage=page.locator('.user-message-attachments img')
  await expect.poll(()=>oldImage.evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
  await expect(page.locator('.user-message-attachments .attachment-image-caption')).toHaveCount(0)
  await expect(oldImage).toHaveCSS('object-fit','cover')
  const oldThumbnail=await page.locator('.user-message-attachments .attachment-image').boundingBox()
  assert(Math.abs(oldThumbnail.width-100)<1&&Math.abs(oldThumbnail.height-100)<1)
  await expect(page.locator('.message-user')).not.toContainText('附件（本地文件路径）')
  await expect(page.locator('.message-user')).not.toContainText('/Users/example')
  const input=page.getByRole('textbox',{name:'任务指令'})
  await input.fill('继续分析这张图')
  const paste=()=>input.evaluate(node=>node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true})))
  await paste()
  const draftImage=page.locator('.composer-images img')
  await expect.poll(()=>draftImage.evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
  await expect(page.locator('.composer-images .attachment-image-caption')).toHaveCount(0)
  await expect(draftImage).toHaveCSS('object-fit','cover')
  await expect(page.locator('.composer-images')).not.toContainText('/tmp/')
  await page.screenshot({path:`${output}/inline-${width}-${reducedMotion}.png`})
  const trigger=page.getByRole('button',{name:'预览图片 待发送截图.png',exact:true})
  await trigger.focus();await page.keyboard.press('Enter')
  const dialog=page.getByRole('dialog',{name:'待发送截图.png'})
  await expect(dialog).toBeVisible();await expect(dialog).toHaveCSS('opacity','1')
  assert(await dialog.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0))
  const rect=await dialog.boundingBox();assert(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=width && rect.y+rect.height<=height)
  await page.screenshot({path:`${output}/expanded-${width}-${reducedMotion}.png`})
  await page.keyboard.press('Escape');await expect(trigger).toBeFocused()
  // Repeated open/close, including reversal while the shared fade is still running.
  await trigger.click();await page.keyboard.press('Escape')
  const exit=await page.evaluate(()=>{const node=document.querySelector('[data-dialog-exit="content"]');return node?{inert:node.inert,animated:node.getAnimations().length>0}:null})
  if(reducedMotion==='reduce')assert.equal(exit,null);else if(exit)assert(exit.inert&&exit.animated)
  await trigger.click();await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'关闭图片预览'}).click();await expect(trigger).toBeFocused()
  await page.getByRole('button',{name:'发送指令',exact:true}).click()
  await expect(page.locator('.composer-images')).toHaveCount(0)
  const sent=await page.evaluate(()=>window.__sent.prompt)
  assert(sent.includes('"/tmp/待发送截图.png"'));assert(!sent.includes('data:image'))
  await expect(page.locator('.user-message-attachments img')).toHaveCount(2)
  await expect.poll(()=>page.locator('.user-message-attachments img').last().evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
  await page.evaluate(()=>{window.__imageError=true});await paste()
  await expect(page.locator('.composer-images')).toContainText('图片无法预览')
  await page.evaluate(()=>{window.__imageError=false})
  await page.getByRole('button',{name:'重新加载图片 待发送截图.png'}).click()
  await expect.poll(()=>draftImage.evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
  await page.locator('#workbench-pane').evaluate(node=>node.style.flex='0 0 340px')
  const composer=await page.locator('.composer').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));assert(composer.scroll<=composer.client)
  await expect(page.getByRole('button',{name:'移除附件 待发送截图.png'})).toBeInViewport()
  await page.screenshot({path:`${output}/narrow-${width}-${reducedMotion}.png`})
  await page.getByRole('button',{name:'移除附件 待发送截图.png'}).click();await expect(input).toBeFocused()
  report.checks.push({width,height,reducedMotion,legacyImageDecoded:true,composerImageDecoded:true,sentImageDecoded:true,pathOnlyForModel:true,dialogFits:true,focusRestored:true,retry:true,narrowPane:340,exit})
  await context.close()
 }
 assert.deepEqual(report.errors,[]);report.status='passed'
}finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await browser.close()}
console.log(JSON.stringify(report,null,2))
