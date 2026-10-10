import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const output = 'test-results/artifact-preview-upgrade'
const viteUrl = process.env.GOALWARD_PREVIEW_URL ?? 'http://127.0.0.1:1420'
const limit = 500 * 1024 * 1024
await mkdir(output, { recursive: true })

// A real two-page PDF with an xref table. Padding forces the renderer to fetch
// more than one native byte range; the fixture never pretends to be a 500 MB PDF.
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 480] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 480] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'q 0.25 0.35 0.45 rg 32 100 296 180 re f Q\nBT /F1 18 Tf 32 420 Td (GOALWARD PDF PAGE ONE) Tj ET',
    'q 0.8 0.1 0.1 rg 90 160 180 180 re f Q\nBT /F1 18 Tf 32 420 Td (GOALWARD PDF PAGE TWO) Tj ET',
  ]
  let document = '%PDF-1.4\n' + '% range fixture padding\n'.repeat(50_000)
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document))
    if (index >= 5) object = `<< /Length ${Buffer.byteLength(object)} >>\nstream\n${object}\nendstream`
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(document)
}
const pdf = pdfFixture()
await writeFile(`${output}/two-pages.pdf`, pdf)
await writeFile(`${output}/harness.html`, '<!doctype html><html class="dark" lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>')
// The generated page is also a usable interactive fixture outside Playwright.
// An existing init-script/native bridge always wins; no mock leaks into the app.
await writeFile(`${output}/demo-ipc.ts`, `if (!(window as any).__TAURI_INTERNALS__) {
  (window as any).isTauri = true;
  const limit = ${limit};
  let bytes: Promise<Uint8Array> | undefined;
  const readPdf = () => bytes ??= fetch('./two-pages.pdf').then(response => response.arrayBuffer()).then(buffer => new Uint8Array(buffer));
  (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
    if (command === 'read_artifact') {
      if (args.path === '读取失败.pdf') throw new Error('模拟文件读取失败，可切换到预览样例.pdf');
      const size = args.path === '边界500MB.txt' ? limit : args.path.includes('超限') ? limit + 1024 * 1024 : args.path.endsWith('.pdf') ? args.path === '损坏.pdf' ? 13 : (await readPdf()).length : 24;
      if (size > limit && !args.allowLarge) return {path:args.path,content:'',bytes:size,tooLarge:true};
      if (args.path.endsWith('.pdf')) return {path:args.path,content:'',bytes:size,pdf:true};
      const content = args.path.endsWith('.html') ? '<!doctype html><h1>超限 HTML 已加载</h1>' : args.path === '说明.md' ? '# 文本预览正常' : args.path === '边界500MB.txt' ? 'Boundary 500 MB file loads directly' : 'Second oversized file opened';
      return {path:args.path,bytes:size,content};
    }
    if (command === 'read_artifact_pdf_chunk') {
      const data = args.path === '损坏.pdf' ? new TextEncoder().encode('%PDF-broken!!') : await readPdf();
      return data.slice(args.offset, args.offset + args.length);
    }
    if (command === 'open_external_url') { window.open(args.url, '_blank', 'noopener,noreferrer'); return; }
    if (command === 'open_artifact') throw new Error('此交互页使用模拟文件读取；系统打开和 Finder 请在桌面应用中验证。');
    throw new Error('Unexpected demo command: ' + command);
  }};
}
export {};
`)
await writeFile(`${output}/harness.tsx`, `import './demo-ipc'
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ArtifactPreview,ArtifactPreviewEmpty} from '/src/components/ArtifactPreview'
import {Button} from '/src/components/ui/button'
import '/src/index.css'
const base={directory:'/tmp/artifact-preview-fixture',source:'reply',sourceId:'reply',createdAt:''};
const files=['边界500MB.txt','超限501MB.html','第二个超限文件.txt','预览样例.pdf','读取失败.pdf','损坏.pdf','慢速.pdf','说明.md'];
function Harness(){const [artifact,setArtifact]=useState(null);const openFile=name=>setArtifact({...base,id:name,name,path:name,kind:name.endsWith('.html')?'html':name.endsWith('.md')?'markdown':'file'});const openUrl=url=>setArtifact({...base,id:url,url,name:new URL(url).hostname,kind:'web'});return <div style={{height:'100vh',display:'flex'}}><main style={{flex:1,minWidth:0,padding:24}}><h1>产物预览交互验收 · 模拟文件读取</h1><div style={{display:'flex',flexWrap:'wrap',gap:8}}>{files.map(file=><Button key={file} onClick={()=>openFile(file)}>{file}</Button>)}<Button onClick={()=>setArtifact(null)}>清空预览</Button></div></main><div id="preview-pane" style={{width:620,minHeight:0,flexShrink:0}}>{artifact?<ArtifactPreview artifact={artifact} onOpenUrl={openUrl}/>:<ArtifactPreviewEmpty onOpenUrl={openUrl}/>}</div></div>};createRoot(document.getElementById('root')).render(<Harness/>);`)

const webServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><h1>UTF-8 网页预览</h1><p>中文内容与空格正常。</p><button id="action">执行网页脚本</button><output id="result"></output><script>document.querySelector("#action").onclick=()=>document.querySelector("#result").textContent="网页脚本已执行"</script></body></html>')
})
await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve))
const webUrl = `http://127.0.0.1:${webServer.address().port}/网页预览`
const report = {
  scope: 'Real React and PDF.js canvas rendering with controlled Tauri IPC and local UTF-8 HTTP content. Native filesystem, packaged macOS WebKit, and arbitrary external sites require separate validation.',
  scenarios: [], errors: [],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function canvasInk(canvas) {
  return canvas.evaluate(node => {
    const { data } = node.getContext('2d').getImageData(0, 0, node.width, node.height)
    let ink = 0
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 0 && Math.min(data[index], data[index + 1], data[index + 2]) < 200) ink++
    return { width: node.width, height: node.height, ink }
  })
}

try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, locale: 'zh-CN' })
    await context.addInitScript(({ pdf, limit }) => {
      window.isTauri = true
      window.__artifactReads = []
      window.__pdfReads = []
      window.__pdfFail = true
      window.__resumePdf = []
      window.__externalUrls = []
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text } } })
      const fixture = Uint8Array.from(atob(pdf), character => character.charCodeAt(0))
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === 'read_artifact') {
          window.__artifactReads.push(args)
          const bytes = args.path === '边界500MB.txt' ? limit : args.path.includes('超限') ? limit + 1024 * 1024 : args.path.endsWith('.pdf') ? args.path === '损坏.pdf' ? 13 : fixture.length : 24
          if (bytes > limit && !args.allowLarge) return { path: args.path, content: '', bytes, tooLarge: true }
          if (args.path.endsWith('.pdf')) return { path: args.path, content: '', bytes, pdf: true }
          const content = args.path.endsWith('.html') ? '<!doctype html><h1>超限 HTML 已加载</h1>' : args.path === '说明.md' ? '# 文本预览正常' : args.path === '边界500MB.txt' ? 'Boundary 500 MB file loads directly' : 'Second oversized file opened'
          return { path: args.path, bytes, content }
        }
        if (command === 'read_artifact_pdf_chunk') {
          window.__pdfReads.push(args)
          if (args.path === '读取失败.pdf' && window.__pdfFail) throw new Error('PDF 字节读取失败，请重试')
          if (args.path === '慢速.pdf') await new Promise(resolve => window.__resumePdf.push(resolve))
          const data = args.path === '损坏.pdf' ? new TextEncoder().encode('%PDF-broken!!') : fixture
          return [...data.slice(args.offset, args.offset + args.length)]
        }
        if (command === 'open_external_url') { window.__externalUrls.push(args.url); return }
        if (command === 'open_artifact') return
        throw new Error('Unexpected native command: ' + command)
      } }
    }, { pdf: pdf.toString('base64'), limit })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    await page.goto(`${viteUrl}/${output}/harness.html`)
    const preview = page.getByRole('complementary', { name: '产物预览' })
    const urlInput = () => preview.getByRole('textbox', { name: '输入网页 URL' })
    await expect(urlInput()).toBeVisible()
    await urlInput().fill('javascript:alert(1)')
    await urlInput().press('Enter')
    await expect(preview.getByRole('alert')).toContainText('请输入有效的 HTTP 或 HTTPS 网页地址。')
    await expect(preview.locator('iframe')).toHaveCount(0)

    await page.getByRole('button', { name: '边界500MB.txt', exact: true }).click()
    await expect(preview.locator('pre').first()).toContainText('Boundary 500 MB file loads directly')
    await expect(preview.getByRole('button', { name: '仍要打开' })).toHaveCount(0)
    await page.getByRole('button', { name: '超限501MB.html', exact: true }).click()
    await expect(preview.getByRole('button', { name: '仍要打开' })).toBeVisible()
    await expect(preview.getByRole('alert')).toContainText('500 MB')
    await expect(preview.locator('iframe')).toHaveCount(0)
    const beforeOpen = await page.evaluate(() => window.__artifactReads.length)
    await preview.getByRole('button', { name: '仍要打开' }).click()
    await expect.poll(() => page.evaluate(() => window.__artifactReads.length)).toBeGreaterThan(beforeOpen)
    assert.equal(await page.evaluate(() => window.__artifactReads.at(-1).allowLarge), true)
    await expect(preview.locator('iframe')).toBeVisible()
    await expect(page.frameLocator('iframe').getByRole('heading', { name: '超限 HTML 已加载' })).toBeVisible()
    await preview.getByRole('tab', { name: '源码' }).click()
    await expect(preview.locator('pre')).toContainText('超限 HTML 已加载')
    await preview.getByRole('button', { name: '复制文件内容' }).click()
    await expect.poll(() => page.evaluate(() => window.__copied)).toContain('超限 HTML 已加载')
    await page.getByRole('button', { name: '第二个超限文件.txt', exact: true }).click()
    await expect(preview.getByRole('button', { name: '仍要打开' })).toBeVisible()
    assert.equal(await page.evaluate(() => !!window.__artifactReads.at(-1).allowLarge), false)
    await page.getByRole('button', { name: '超限501MB.html', exact: true }).click()
    await expect(preview.getByRole('button', { name: '仍要打开' })).toBeVisible()
    await page.screenshot({ path: `${output}/size-gate-${width}-${reducedMotion}.png` })

    await page.getByRole('button', { name: '预览样例.pdf', exact: true }).click()
    const firstPage = preview.getByRole('img', { name: 'PDF 第 1 页', exact: true })
    await expect(firstPage).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await canvasInk(firstPage)).ink).toBeGreaterThan(1000)
    const firstInk = await canvasInk(firstPage)
    await expect(preview.getByRole('tab', { name: '源码' })).toHaveCount(0)
    await expect(preview.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
    await preview.getByRole('button', { name: '复制文件路径' }).click()
    await expect.poll(() => page.evaluate(() => window.__copied)).toBe('/tmp/artifact-preview-fixture/预览样例.pdf')
    await preview.getByRole('button', { name: '下一页', exact: true }).click()
    const secondPage = preview.getByRole('img', { name: 'PDF 第 2 页', exact: true })
    await expect(secondPage).toBeVisible()
    await expect.poll(async () => (await canvasInk(secondPage)).ink).toBeGreaterThan(1000)
    const secondInk = await canvasInk(secondPage)
    assert.notEqual(firstInk.ink, secondInk.ink)
    await expect(preview.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    const pageInput = preview.getByLabel('页码', { exact: true })
    await pageInput.fill('1')
    await pageInput.press('Enter')
    await expect(firstPage).toBeVisible()
    // Rapid keyboard retargeting must leave the page matching the latest input.
    await pageInput.fill('2')
    await pageInput.press('Enter')
    await pageInput.fill('1')
    await pageInput.press('Enter')
    await expect(firstPage).toBeVisible()
    await expect.poll(async () => (await canvasInk(firstPage)).ink).toBeGreaterThan(1000)
    const fitCanvasWidth = await firstPage.evaluate(node => node.width)
    await preview.getByRole('button', { name: '放大', exact: true }).click()
    await expect.poll(() => firstPage.evaluate(node => node.width)).toBeGreaterThan(fitCanvasWidth)
    await preview.getByRole('button', { name: '适应宽度', exact: true }).click()
    await expect.poll(() => firstPage.evaluate(node => node.width)).toBe(fitCanvasWidth)
    const ranges = await page.evaluate(() => window.__pdfReads.filter(read => read.path === '预览样例.pdf'))
    assert(ranges.length > 1, 'The real PDF must require multiple byte range reads')
    assert(ranges.every(read => Number.isInteger(read.offset) && read.offset >= 0 && read.length > 0 && read.length <= 1024 * 1024))
    await page.screenshot({ path: `${output}/pdf-${width}-${reducedMotion}.png` })
    await page.locator('#preview-pane').evaluate(node => { node.style.width = '280px' })
    await expect(firstPage).toBeInViewport()
    await expect.poll(async () => (await canvasInk(firstPage)).ink).toBeGreaterThan(1000)
    const layout = await preview.evaluate(node => ({
      width: node.clientWidth, scroll: node.scrollWidth,
      toolbar: node.querySelector('.artifact-toolbar').getBoundingClientRect().height,
      controls: [...node.querySelectorAll('button')].map(button => ({ width: button.getBoundingClientRect().width, right: button.getBoundingClientRect().right })),
    }))
    assert.equal(layout.toolbar, 40)
    assert(layout.scroll <= layout.width, 'Narrow preview must not overflow horizontally')
    assert(layout.controls.every(control => control.width >= 28 && control.right <= width), 'Preview buttons must retain their minimum hit area and stay inside the window')
    const transition = await firstPage.evaluate(node => getComputedStyle(node).transitionDuration)
    if (reducedMotion === 'reduce') assert.equal(transition, '0s')
    await page.screenshot({ path: `${output}/pdf-narrow-${width}-${reducedMotion}.png` })

    await page.getByRole('button', { name: '读取失败.pdf', exact: true }).click()
    await expect(preview.getByRole('alert')).toContainText('PDF 字节读取失败')
    await page.evaluate(() => { window.__pdfFail = false })
    await preview.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(firstPage).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await canvasInk(firstPage)).ink).toBeGreaterThan(1000)
    await page.getByRole('button', { name: '损坏.pdf', exact: true }).click()
    await expect(preview.getByRole('alert')).toBeVisible()
    await expect(preview.getByRole('button', { name: '重新读取', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '慢速.pdf', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__resumePdf.length)).toBeGreaterThan(0)
    await expect(preview.getByText('正在加载 PDF…', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '说明.md', exact: true }).click()
    await expect(preview.getByRole('heading', { name: '文本预览正常' })).toBeVisible()
    await page.evaluate(() => { window.__resumePdf.splice(0).forEach(resolve => resolve()) })
    await expect(preview.locator('canvas')).toHaveCount(0)
    await expect(preview.getByRole('heading', { name: '文本预览正常' })).toBeVisible()

    await urlInput().fill('https://user:password@example.com/')
    await urlInput().press('Enter')
    await expect(preview.getByRole('alert')).toContainText('请输入有效的 HTTP 或 HTTPS 网页地址。')
    await expect(preview.getByRole('heading', { name: '文本预览正常' })).toBeVisible()
    await urlInput().fill(webUrl)
    await urlInput().press('Enter')
    const webFrame = page.frameLocator('iframe')
    await expect(webFrame.getByRole('heading', { name: 'UTF-8 网页预览' })).toBeVisible()
    await expect(webFrame.getByText('中文内容与空格正常。')).toBeVisible()
    await webFrame.getByRole('button', { name: '执行网页脚本' }).click()
    await expect(webFrame.locator('output')).toHaveText('网页脚本已执行')
    await preview.getByRole('button', { name: '复制链接' }).click()
    const normalizedWebUrl = new URL(webUrl).href
    await expect.poll(() => page.evaluate(() => window.__copied)).toBe(normalizedWebUrl)
    await preview.getByRole('button', { name: '系统浏览器打开' }).click()
    await expect.poll(() => page.evaluate(() => window.__externalUrls.at(-1))).toBe(normalizedWebUrl)
    await preview.getByRole('button', { name: '刷新网页' }).click()
    await expect(webFrame.getByRole('heading', { name: 'UTF-8 网页预览' })).toBeVisible()
    await expect(webFrame.locator('output')).toHaveText('')
    await page.screenshot({ path: `${output}/url-narrow-${width}-${reducedMotion}.png` })
    await page.getByRole('button', { name: '清空预览', exact: true }).click()
    await expect(urlInput()).toBeVisible()
    await urlInput().fill(webUrl)
    await preview.getByRole('button', { name: '打开网页预览' }).click()
    await expect(webFrame.getByRole('heading', { name: 'UTF-8 网页预览' })).toBeVisible()
    report.scenarios.push({ width, height, reducedMotion, limitBytes: limit, boundaryLoads: true, oversizedGate: true, overrideResets: true, realPdfPages: 2, byteRangeReads: ranges.length, firstInk, secondInk, pdfRetry: true, corruptPdfError: true, stalePdfCancelled: true, narrowWidth: layout.width, toolbarHeight: layout.toolbar, canvasTransition: transition, urlValidation: true, keyboardUrl: true, utf8Web: true, webScript: true, webCopy: true, webRefresh: true, systemBrowserDispatch: true, emptyPreviewUrl: true })
    await context.close()
  }
  assert.deepEqual(report.errors, [])
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.failure = String(error)
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  throw error
} finally {
  await browser.close()
  await new Promise(resolve => webServer.close(resolve))
}
