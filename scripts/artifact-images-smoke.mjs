import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const output = 'test-results/artifact-images'
await mkdir(output, { recursive: true })
await writeFile(`${output}/harness.html`, '<!doctype html><html class="dark"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>')
await writeFile(`${output}/harness.tsx`, `import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ArtifactPreview} from '/src/components/ArtifactPreview'
import {Button} from '/src/components/ui/button'
import '/src/index.css'
const base={directory:'/tmp/image-fixture',source:'reply',sourceId:'reply',createdAt:'',kind:'file'};
const files=['岛台石材-方案1.JPG','透明图片.png','损坏.jpg','慢速.jpg','说明.md'];
function Harness(){const [name,setName]=useState(files[0]);return <div style={{height:'100vh',display:'flex'}}><main style={{flex:1,padding:24}}><h1>图片产物预览验收</h1>{files.map(file=><Button key={file} onClick={()=>setName(file)}>{file}</Button>)}</main><div id="preview-pane" style={{width:620,minHeight:0}}><ArtifactPreview artifact={{...base,id:name,name,path:name,kind:name.endsWith('.md')?'markdown':'file'}}/></div></div>};createRoot(document.getElementById('root')).render(<Harness/>);`)
const png = 'data:image/png;base64,' + (await readFile('assets/branding/goalward-icon.png')).toString('base64')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = { scope: 'Real React image decoding/layout with simulated read_artifact IPC; native filesystem covered by Rust tests, not a native WebKit end-to-end run.', scenarios: [], errors: [] }
try {
  for (const [width,height] of [[1536,960],[1280,720]]) for (const reducedMotion of ['no-preference','reduce']) {
    const context = await browser.newContext({viewport:{width,height},reducedMotion})
    await context.addInitScript(png => {
      const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900
      const ctx=canvas.getContext('2d');ctx.fillStyle='#b8a38c';ctx.fillRect(0,0,1600,900);ctx.fillStyle='#383e39';ctx.fillRect(150,150,1300,600);ctx.fillStyle='#eaece8';ctx.font='72px sans-serif';ctx.fillText('JPEG · 1600 × 900',380,480)
      window.__jpeg=canvas.toDataURL('image/jpeg')
      window.isTauri=true;window.__reads=[];window.__fail=false
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}}})
      window.__TAURI_INTERNALS__={invoke:async (command,args)=>{
        if(command!=='read_artifact') throw new Error('Unexpected command: '+command)
        window.__reads.push(args)
        if(window.__fail) throw new Error('文件不存在或无法访问')
        if(args.path==='慢速.jpg') await new Promise(resolve=>{window.__finish=resolve})
        if(args.path==='说明.md') return {content:'# 文本预览正常'}
        return {content:'',imageDataUrl:args.path==='损坏.jpg'?'data:image/jpeg;base64,broken':args.path.endsWith('.png')?png:window.__jpeg}
      }}
    },png)
    const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message))
    await page.goto(`http://127.0.0.1:1420/${output}/harness.html`)
    const preview=page.getByRole('complementary',{name:'产物预览'})
    const image=preview.getByRole('img',{name:'岛台石材-方案1.JPG'})
    await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(n=>n.naturalWidth)).toBe(1600)
    await expect(preview.getByRole('tab',{name:'源码'})).toHaveCount(0)
    await expect(preview.getByRole('heading',{name:'岛台石材-方案1.JPG'})).toBeFocused()
    await preview.getByRole('button',{name:'复制文件路径'}).click()
    await expect.poll(()=>page.evaluate(()=>window.__copied)).toBe('/tmp/image-fixture/岛台石材-方案1.JPG')
    const transition=await image.evaluate(n=>getComputedStyle(n).transitionDuration)
    assert.equal(transition==='0s',reducedMotion==='reduce')
    await expect.poll(()=>image.evaluate(n=>Number(getComputedStyle(n).opacity))).toBe(1)
    await page.screenshot({path:`${output}/jpeg-${width}-${reducedMotion}.png`})
    await preview.getByRole('button',{name:'刷新文件'}).click()
    await expect.poll(()=>page.evaluate(()=>window.__reads.length)).toBe(2)
    await page.evaluate(()=>window.__fail=true)
    await preview.getByRole('button',{name:'刷新文件'}).click()
    await expect(preview.getByRole('alert')).toContainText('仍显示上次读取的内容')
    await expect(image).toBeVisible()
    await page.evaluate(()=>window.__fail=false)
    await preview.getByRole('button',{name:'重新读取'}).click()
    await expect(preview.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button',{name:'透明图片.png',exact:true}).click()
    const transparent=preview.getByRole('img',{name:'透明图片.png'})
    await expect.poll(()=>transparent.evaluate(n=>n.complete&&n.naturalWidth>0)).toBe(true)
    await page.locator('#preview-pane').evaluate(n=>n.style.width='280px')
    await expect(transparent).toBeInViewport()
    const layout=await preview.evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,toolbar:n.querySelector('.artifact-toolbar').getBoundingClientRect().height,buttons:[...n.querySelectorAll('.artifact-toolbar button')].map(b=>({x:b.getBoundingClientRect().right,width:b.getBoundingClientRect().width}))}))
    assert.equal(layout.toolbar,40);assert(layout.scroll<=layout.width);assert(layout.buttons.every(b=>b.width>=28&&b.x<=width))
    await expect.poll(()=>transparent.evaluate(n=>Number(getComputedStyle(n).opacity))).toBe(1)
    await page.screenshot({path:`${output}/narrow-${width}-${reducedMotion}.png`})
    await page.getByRole('button',{name:'损坏.jpg',exact:true}).click()
    await expect(preview.getByRole('alert')).toContainText('图片无法解码')
    await page.getByRole('button',{name:'慢速.jpg',exact:true}).click()
    await expect(preview.getByText('正在读取图片…',{exact:true})).toBeVisible()
    await expect(preview.getByRole('button',{name:'刷新文件'})).toBeDisabled()
    const animation=await preview.getByRole('button',{name:'刷新文件'}).locator('svg').evaluate(n=>getComputedStyle(n).animationName)
    assert.equal(animation==='none',reducedMotion==='reduce')
    await page.getByRole('button',{name:'说明.md',exact:true}).click()
    await expect(preview.getByRole('heading',{name:'文本预览正常'})).toBeVisible()
    await page.evaluate(()=>window.__finish())
    await expect(preview.getByRole('img')).toHaveCount(0)
    await expect(preview.getByRole('tab',{name:'源码'})).toBeVisible()
    report.scenarios.push({width,height,reducedMotion,jpegDecoded:true,pngDecoded:true,fit:true,refresh:true,retry:true,decodeError:true,staleReadIgnored:true,narrowWidth:280,toolbarHeight:layout.toolbar,transition,loadingAnimation:animation})
    await context.close()
  }
  assert.deepEqual(report.errors,[])
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {await browser.close()}
