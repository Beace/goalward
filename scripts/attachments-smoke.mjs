import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const output = 'test-results/attachments'
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>')
await writeFile(`${output}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Workbench} from '/src/components/Workbench'
import {createInitialState,createTask} from '/src/lib/domain'
import '/src/index.css'
const {settings}=createInitialState();const task=createTask(settings,'检查剪贴板中的图片和文件','/tmp','solo');
function Harness(){const [current,setCurrent]=useState(task);return <div className="app-shell"><header className="titlebar">Goalward · 附件交互验证（模拟桥接）</header><div style={{display:'flex',flex:1,minHeight:0}}><aside style={{width:224,borderRight:'1px solid var(--color-border)',padding:16}}>任务</aside><div id="workbench-pane" style={{flex:1,minWidth:0,minHeight:0}}><Workbench task={current} settings={settings} selectedRunId="" onSelectRun={()=>{}} onChange={setCurrent} onSend={(prompt,recipient)=>{window.__sent={prompt,recipient};return new Promise((resolve,reject)=>{window.__resolve=resolve;window.__reject=reject})}} onStop={()=>{}} onSettings={()=>{}} onInspector={()=>{}} inspectorOpen={true} onDuplicate={()=>{}}/></div><aside style={{width:336,borderLeft:'1px solid var(--color-border)',padding:16}}>执行过程</aside></div></div>};createRoot(document.getElementById('root')).render(<Harness/>)`)
const imageSource = 'data:image/png;base64,' + (await readFile('assets/branding/goalward-icon.png')).toString('base64')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = { scope: 'Rendered React UI with mocked Tauri IPC; actual AppKit clipboard covered separately by Rust tests.', checks: [], errors: [] }
try {
  for (const [width, height] of [[1536,960],[1280,720]]) for (const reducedMotion of ['no-preference','reduce']) {
    const context = await browser.newContext({ viewport: {width,height}, reducedMotion })
    await context.addInitScript(imageSource => {
      window.isTauri = true
      window.__clipboard = []
      window.__TAURI_INTERNALS__ = { invoke: async command => {
        if(command === 'read_attachment_image') return imageSource
        if(command === 'read_clipboard_attachments') {
          if(window.__failPaste) throw new Error('附件读取失败，请重试')
          if(window.__delayPaste) await new Promise(resolve => {window.__finishPaste=resolve})
          return window.__clipboard
        }
        throw new Error('unexpected command '+command)
      }}
    }, imageSource)
    const page=await context.newPage()
    page.on('pageerror',error=>report.errors.push(error.message))
    await page.goto(`http://127.0.0.1:1420/${output}/harness.html`)
    const input=page.getByRole('textbox',{name:'任务指令'})
    const send=page.getByRole('button',{name:'发送指令',exact:true})
    const paste=async (text='')=>input.evaluate((node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))},text)
    await input.fill('请分析这些附件')
    await page.evaluate(()=>{window.__clipboard=[{name:'需求说明 中文.pdf',path:'/Users/example/Documents/需求说明 中文.pdf'},{name:'截图-20260917-221500.png',path:'/Users/example/Library/Application Support/dev.goalward.desktop/attachments/uuid/截图-20260917-221500.png'},{name:'这是一份非常长的文件名用于检查窄窗口中附件名称省略和按钮边界.md',path:'/Users/example/Documents/reports/这是一份非常长的文件名用于检查窄窗口中附件名称省略和按钮边界.md'}]})
    await paste()
    await expect(page.getByRole('listitem')).toHaveCount(3)
    for(const row of await page.locator('.composer-attachment').all()) {
      assert.equal((await row.boundingBox()).height,40)
      const button=row.getByRole('button');const box=await button.boundingBox()
      assert(box.width>=28 && box.height>=28)
      await expect(button).toBeInViewport()
    }
    await expect(page.locator('.composer-images img')).toBeVisible()
    await expect.poll(()=>page.locator('.composer-images img').evaluate(node=>node.complete && node.naturalWidth>0)).toBe(true)
    await page.screenshot({path:`${output}/attachments-${width}-${reducedMotion}.png`})
    const details=page.locator('.composer-attachment-details').last()
    await details.focus();await expect(page.getByRole('tooltip')).toContainText('/Users/example/Documents/reports/')
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'移除附件 需求说明 中文.pdf'}).click();await expect(input).toBeFocused()
    await expect(page.getByRole('listitem')).toHaveCount(2)
    await input.press('Meta+Enter');await expect.poll(()=>page.evaluate(()=>window.__sent.prompt)).toContain('attachments/uuid/截图-20260917-221500.png')
    await page.evaluate(()=>window.__reject(new Error('模拟发送失败')))
    await expect(page.getByRole('alert')).toContainText('模拟发送失败');await expect(page.getByRole('listitem')).toHaveCount(2)
    await send.click()
    await page.evaluate(()=>{window.__clipboard=[{name:'新附件.txt',path:'/tmp/新附件.txt'}]})
    await paste();await expect(page.getByRole('listitem')).toHaveCount(3)
    await input.fill('下一条草稿');await page.evaluate(()=>window.__resolve());await expect(page.getByRole('listitem')).toHaveCount(1);await expect(input).toHaveValue('下一条草稿')
    await page.getByRole('button',{name:'移除附件 新附件.txt'}).click()
    await page.evaluate(()=>{window.__clipboard=[]})
    await input.fill('前文后文');await input.evaluate(node=>node.setSelectionRange(2,2));await paste('普通文字')
    await expect(input).toHaveValue('前文普通文字后文')
    // Native paste must preserve browser text undo semantics.
    await input.press('Meta+z');await expect(input).toHaveValue('前文后文')
    await page.evaluate(()=>{window.__delayPaste=true;window.__clipboard=[{name:'等待图片.png',path:'/tmp/等待图片.png'}]})
    await paste();await expect(send).toBeDisabled();await expect(page.locator('.composer-importing')).toContainText('正在添加附件')
    const spinner=page.locator('.composer-importing svg')
    const animation=await spinner.evaluate(node=>getComputedStyle(node).animationName)
    assert.equal(animation==='none',reducedMotion==='reduce')
    await page.evaluate(()=>{window.__delayPaste=false;window.__finishPaste()});await expect(send).toBeEnabled()
    await page.evaluate(()=>{window.__failPaste=true})
    await paste();await expect(page.getByRole('alert')).toContainText('附件读取失败')
    // Narrow conversation pane independently of the desktop viewport.
    await page.locator('#workbench-pane').evaluate(node=>{node.style.flex='0 0 340px'})
    await expect(page.getByRole('button',{name:'移除附件 等待图片.png'})).toBeInViewport()
    const layout=await page.locator('.composer').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}))
    assert(layout.scroll<=layout.client)
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    report.checks.push({width,height,reducedMotion,rows40px:true,focusRestored:true,tooltipKeyboard:true,draftPreserved:true,textUndo:true,narrowPane:340,spinnerAnimation:animation})
    await context.close()
  }
  assert.deepEqual(report.errors,[]);report.status='passed'
} finally {
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2))
  await browser.close()
}
console.log(JSON.stringify(report,null,2))
