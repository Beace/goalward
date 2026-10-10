import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { readArtifactPdfChunk } from '@/lib/bridge'
import { useI18n } from '@/i18n'
import { Button } from './ui/button'
import { Input } from './ui/input'
import './artifact-pdf.css'

// Use the legacy build's WebKit polyfills and a bundled worker, independent of
// the WebView's PDF plugin. No file URL, full-file base64 or remote CDN is used.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const RANGE_SIZE = 64 * 1024
const IPC_CHUNK_SIZE = 1024 * 1024
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
const pdfAssets = import.meta.glob<string>([
  '/node_modules/pdfjs-dist/cmaps/*.bcmap',
  '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '/node_modules/pdfjs-dist/wasm/*.wasm',
], { query: '?url', import: 'default', eager: true })
const resourceUrls = new Map(Object.entries(pdfAssets).map(([path, url]) => [path.split('/').at(-1)!, url]))

// Vite hashes each resource separately; resolve PDF.js' requested filename to
// its bundled URL so CJK maps, standard fonts and image decoders work offline.
class BundledPdfDataFactory {
  async fetch({ filename }: { filename: string }) {
    const url = resourceUrls.get(filename)
    if (!url) throw new Error(`Missing bundled PDF resource: ${filename}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to load PDF resource: ${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

class ArtifactPdfRange extends PDFDataRangeTransport {
  private stopped = false
  constructor(length: number, initial: Uint8Array, private read: (offset: number, length: number) => Promise<Uint8Array>, private fail: (error: unknown) => void) {
    super(length, initial, true)
  }
  override requestDataRange(begin: number, end: number) {
    void this.loadRange(begin, end).catch(error => {
      if (!this.stopped) { this.stopped = true; this.fail(error) }
    })
  }
  private async loadRange(begin: number, end: number) {
    if (this.stopped) return
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > this.length || end <= begin) throw new Error('Invalid PDF byte range')
    // PDF.js can merge adjacent ranges. Keep every native IPC response bounded
    // while delivering the exact requested range to its reader.
    const bytes = new Uint8Array(end - begin)
    for (let offset = begin; offset < end; offset += IPC_CHUNK_SIZE) {
      if (this.stopped) return
      const length = Math.min(IPC_CHUNK_SIZE, end - offset)
      const chunk = await this.read(offset, length)
      if (this.stopped) return
      if (chunk.length !== length) throw new Error('PDF file changed while reading')
      bytes.set(chunk, offset - begin)
    }
    if (!this.stopped) this.onDataRange(begin, bytes)
  }
  override abort() { this.stopped = true }
}

export interface ArtifactPdfProps {
  directory: string
  path: string
  bytes: number
  allowLarge: boolean
  revision: number
}

export function ArtifactPdf({ directory, path, bytes, allowLarge, revision }: ArtifactPdfProps) {
  const { t } = useI18n()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState(1)
  const [pageDraft, setPageDraft] = useState('1')
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const [pageText, setPageText] = useState('')
  const viewport = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const rendering = useRef<RenderTask | null>(null)
  const currentScale = useRef(1)
  const fitScale = useRef(1)

  useEffect(() => {
    let active = true
    let range: ArtifactPdfRange | undefined
    let loading: PDFDocumentLoadingTask | undefined
    setPdf(null); setError(''); setReady(false); setPage(1); setPageDraft('1'); setZoom('fit'); setPageText('')
    canvasHost.current?.replaceChildren()
    const fail = (cause: unknown) => {
      if (!active) return
      setError(String(cause).replace(/^Error: /, '')); setReady(false)
      rendering.current?.cancel()
      range?.abort()
      void loading?.destroy().catch(() => {})
    }
    void (async () => {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(t('PDF 文件为空或大小无效。', 'PDF is empty or has an invalid file size.'))
      const read = (offset: number, length: number) => readArtifactPdfChunk(directory, path, offset, length, allowLarge)
      const initial = await read(0, Math.min(RANGE_SIZE, bytes))
      if (!active) return
      if (initial.length !== Math.min(RANGE_SIZE, bytes)) throw new Error(t('PDF 文件读取不完整，请重新读取。', 'PDF read was incomplete. Reload the file.'))
      range = new ArtifactPdfRange(bytes, initial, read, fail)
      loading = getDocument({ range, rangeChunkSize: RANGE_SIZE, disableStream: true, disableAutoFetch: true, useWorkerFetch: false, BinaryDataFactory: BundledPdfDataFactory })
      const document = await loading.promise
      if (!active) return
      setPdf(document)
    })().catch(fail)
    return () => {
      active = false
      rendering.current?.cancel()
      range?.abort()
      void loading?.destroy().catch(() => {})
    }
  }, [directory, path, bytes, allowLarge, revision, retry, t])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!pdf || error) return
    let active = true
    let renderTask: RenderTask | undefined
    let renderedPage: PDFPageProxy | undefined
    setReady(false); setPageText('')
    void (async () => {
      const pdfPage = await pdf.getPage(page)
      if (!active || !canvasHost.current) { pdfPage.cleanup(); return }
      renderedPage = pdfPage
      const base = pdfPage.getViewport({ scale: 1 })
      fitScale.current = Math.max(0.1, (width > 0 ? width - 24 : 288) / base.width)
      const scale = zoom === 'fit' ? fitScale.current : zoom
      const target = pdfPage.getViewport({ scale })
      currentScale.current = scale
      // Bound the backing surface even for poster-size pages or high DPI.
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (target.width * target.height)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(target.width * pixelRatio))
      canvas.height = Math.max(1, Math.floor(target.height * pixelRatio))
      canvas.style.width = `${target.width}px`; canvas.style.height = `${target.height}px`
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t(`PDF 第 ${page} 页`, `PDF page ${page}`))
      // Never reuse a canvas that a cancelled PDF.js render still owns.
      canvasHost.current.replaceChildren(canvas)
      renderTask = pdfPage.render({ canvas, viewport: target, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      rendering.current = renderTask
      await renderTask.promise
      if (!active) return
      setReady(true)
      void pdfPage.getTextContent().then(content => {
        if (active) setPageText(content.items.map(item => 'str' in item ? item.str : '').join(' '))
      }).catch(() => {})
    })().catch(cause => {
      if (active && (cause as { name?: string })?.name !== 'RenderingCancelledException') setError(String(cause).replace(/^Error: /, ''))
    })
    return () => {
      active = false; renderTask?.cancel()
      if (rendering.current === renderTask) rendering.current = null
      // Release images/operator lists after the old render has settled. A new
      // render gets its own canvas and never waits for this cleanup.
      if (renderTask) void renderTask.promise.finally(() => renderedPage?.cleanup()).catch(() => {})
      else renderedPage?.cleanup()
    }
  }, [pdf, page, zoom, width, error, t])

  const goToPage = (next: number) => {
    if (!pdf) return
    const value = Math.max(1, Math.min(pdf.numPages, next))
    setPage(value); setPageDraft(String(value))
    if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0 }
  }
  const commitPage = () => goToPage(Number.isSafeInteger(Number(pageDraft)) && Number(pageDraft) > 0 ? Number(pageDraft) : page)
  // Include the fitted scale in the allowed range. Fitting a tiny label can be
  // above 400%, and fitting a poster can be below 25%; zoom must retain direction
  // when leaving fit mode in both cases.
  const minZoom = Math.min(0.25, fitScale.current / 4)
  const maxZoom = Math.max(4, fitScale.current * 4)
  const changeZoom = (delta: number) => {
    setZoom(Math.max(minZoom, Math.min(maxZoom, Math.round(((zoom === 'fit' ? currentScale.current : zoom) + delta) * 100) / 100)))
  }

  return <section className="artifact-pdf" aria-label={t('PDF 预览', 'PDF preview')} aria-busy={!ready && !error}>
    {pdf && !error && <div className="artifact-pdf-toolbar" aria-label={t('PDF 操作', 'PDF controls')}>
      <Button variant="ghost" size="icon-sm" aria-label={t('上一页', 'Previous page')} title={t('上一页', 'Previous page')} disabled={page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft/></Button>
      <Input className="artifact-pdf-page-input" aria-label={t('页码', 'Page number')} title={t('输入页码并按 Enter', 'Enter a page number and press Enter')} inputMode="numeric" value={pageDraft} onChange={event => setPageDraft(event.target.value)} onBlur={commitPage} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commitPage() }
        if (event.key === 'Escape') { event.preventDefault(); setPageDraft(String(page)) }
      }}/>
      <span className="artifact-pdf-page-count">/ {pdf.numPages}</span>
      <Button variant="ghost" size="icon-sm" aria-label={t('下一页', 'Next page')} title={t('下一页', 'Next page')} disabled={page >= pdf.numPages} onClick={() => goToPage(page + 1)}><ChevronRight/></Button>
      <span className="artifact-pdf-toolbar-spacer"/>
      <Button variant="ghost" size="icon-sm" aria-label={t('缩小', 'Zoom out')} title={t('缩小', 'Zoom out')} disabled={zoom !== 'fit' && zoom <= minZoom} onClick={() => changeZoom(-0.25)}><Minus/></Button>
      <span className="artifact-pdf-zoom" aria-live="polite">{zoom === 'fit' ? t('适宽', 'Fit') : `${Math.round(zoom * 100)}%`}</span>
      <Button variant="ghost" size="icon-sm" aria-label={t('放大', 'Zoom in')} title={t('放大', 'Zoom in')} disabled={zoom !== 'fit' && zoom >= maxZoom} onClick={() => changeZoom(0.25)}><Plus/></Button>
      <Button variant="ghost" size="icon-sm" aria-label={t('适应宽度', 'Fit to width')} title={t('适应宽度', 'Fit to width')} aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}><Maximize2/></Button>
    </div>}
    {error && <div className="artifact-load-state" role="alert"><p>{t(`PDF 无法预览：${error}`, `Unable to preview PDF: ${error}`)}</p><Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>{t('重新读取', 'Reload')}</Button></div>}
    <div ref={viewport} className="artifact-pdf-viewport" tabIndex={0} aria-label={t('PDF 内容', 'PDF content')} onKeyDown={event => {
      if (event.target !== event.currentTarget || !pdf || error) return
      if (event.key === 'PageDown') { event.preventDefault(); goToPage(page + 1) }
      if (event.key === 'PageUp') { event.preventDefault(); goToPage(page - 1) }
    }}>
      {!ready && !error && <p className="artifact-pdf-status" role="status">{pdf ? t(`正在渲染第 ${page} 页…`, `Rendering page ${page}…`) : t('正在加载 PDF…', 'Loading PDF…')}</p>}
      <div ref={canvasHost} className="artifact-pdf-canvas" data-ready={ready && !error} aria-hidden={!!error}/>
      {ready && pageText && <p className="sr-only">{pageText}</p>}
    </div>
    {ready && <span className="sr-only" role="status">{t(`第 ${page} 页，共 ${pdf?.numPages} 页`, `Page ${page} of ${pdf?.numPages}`)}</span>}
  </section>
}
