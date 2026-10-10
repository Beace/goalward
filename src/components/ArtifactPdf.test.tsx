// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactPdf } from './ArtifactPdf'

const mocks = vi.hoisted(() => ({ read: vi.fn(), getDocument: vi.fn(), ranges: [] as unknown[] }))
vi.mock('@/lib/bridge', () => ({ readArtifactPdfChunk: mocks.read }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: mocks.getDocument,
  PDFDataRangeTransport: class {
    onDataRange = vi.fn()
    constructor(public length: number, public initialData: Uint8Array) { mocks.ranges.push(this) }
  },
}))
const props = { directory: '/workspace', path: 'report.pdf', bytes: 2 * 1024 * 1024, allowLarge: false, revision: 0 }
function loadingDocument(renderPromise = Promise.resolve(), baseWidth = 200) {
  const renders: { cancel: ReturnType<typeof vi.fn>; promise: Promise<unknown> }[] = []
  const pdf = {
    numPages: 3,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: baseWidth * scale, height: 300 * scale }),
      render: vi.fn(() => { const task = { cancel: vi.fn(), promise: renderPromise }; renders.push(task); return task }),
      getTextContent: vi.fn(async () => ({ items: [{ str: 'Accessible PDF text' }] })),
      cleanup: vi.fn(),
    })),
  }
  const task = { promise: Promise.resolve(pdf), destroy: vi.fn(async () => {}) }
  mocks.getDocument.mockReturnValue(task)
  return { pdf, task, renders }
}
beforeEach(() => {
  mocks.read.mockImplementation(async (_directory, _path, _offset, length) => new Uint8Array(length))
})
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.ranges.length = 0 })

it('renders page canvases and supports bounded keyboard page jumps and zoom', async () => {
  const { pdf, task } = loadingDocument()
  const view = render(<ArtifactPdf {...props}/>)
  await screen.findByRole('img', { name: 'PDF 第 1 页' })
  await screen.findByText('Accessible PDF text')
  expect(mocks.read).toHaveBeenCalledWith('/workspace', 'report.pdf', 0, 65536, false)
  expect(mocks.getDocument.mock.calls[0][0]).toMatchObject({ disableStream: true, disableAutoFetch: true, rangeChunkSize: 65536 })
  expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('img', { name: 'PDF 第 2 页' })
  const pageInput = screen.getByRole('textbox', { name: '页码' })
  fireEvent.change(pageInput, { target: { value: '999' } })
  fireEvent.keyDown(pageInput, { key: 'Enter' })
  await screen.findByRole('img', { name: 'PDF 第 3 页' })
  expect((pageInput as HTMLInputElement).value).toBe('3')
  expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(screen.getByLabelText('PDF 内容'), { key: 'PageUp' })
  await screen.findByRole('img', { name: 'PDF 第 2 页' })
  fireEvent.click(screen.getByRole('button', { name: '放大' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '适应宽度' }).getAttribute('aria-pressed')).toBe('false'))
  fireEvent.click(screen.getByRole('button', { name: '适应宽度' }))
  expect(screen.getByRole('button', { name: '适应宽度' }).getAttribute('aria-pressed')).toBe('true')
  expect(pdf.getPage).toHaveBeenCalledWith(2)
  view.unmount()
  expect(task.destroy).toHaveBeenCalledOnce()
})

it('bounds merged range IPC requests and ignores chunks after disposal', async () => {
  loadingDocument()
  const view = render(<ArtifactPdf {...props} allowLarge/>)
  await screen.findByRole('img', { name: 'PDF 第 1 页' })
  const range = mocks.ranges[0] as { requestDataRange: (begin: number, end: number) => void; onDataRange: ReturnType<typeof vi.fn> }
  await act(async () => { range.requestDataRange(65536, props.bytes) })
  expect(mocks.read.mock.calls.slice(1).map(call => call.slice(2))).toEqual([
    [65536, 1024 * 1024, true], [65536 + 1024 * 1024, 1024 * 1024 - 65536, true],
  ])
  expect(range.onDataRange).toHaveBeenCalledWith(65536, expect.any(Uint8Array))
  let finish: (value: Uint8Array) => void = () => {}
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  range.requestDataRange(0, 1024)
  view.unmount()
  await act(async () => finish(new Uint8Array(1024)))
  expect(range.onDataRange).toHaveBeenCalledTimes(1)
})

it.each([
  { baseWidth: 20, action: '放大', grows: true },
  { baseWidth: 5000, action: '缩小', grows: false },
])('retains zoom direction when fitting a PDF outside the ordinary zoom range: $baseWidth', async ({ baseWidth, action, grows }) => {
  loadingDocument(Promise.resolve(), baseWidth)
  render(<ArtifactPdf {...props}/>)
  await screen.findByText('Accessible PDF text')
  const width = parseFloat((screen.getByRole('img', { name: 'PDF 第 1 页' }) as HTMLCanvasElement).style.width)
  fireEvent.click(screen.getByRole('button', { name: action }))
  await waitFor(() => {
    const next = parseFloat((screen.getByRole('img', { name: 'PDF 第 1 页' }) as HTMLCanvasElement).style.width)
    expect(grows ? next > width : next < width).toBe(true)
  })
})

it('exposes corrupt documents and range errors with reload recovery', async () => {
  const first = loadingDocument()
  const view = render(<ArtifactPdf {...props}/>)
  await screen.findByRole('img', { name: 'PDF 第 1 页' })
  mocks.read.mockRejectedValueOnce(new Error('File no longer exists'))
  const range = mocks.ranges[0] as { requestDataRange: (begin: number, end: number) => void }
  await act(async () => range.requestDataRange(0, 1024))
  expect(screen.getByRole('alert').textContent).toContain('File no longer exists')
  expect(first.task.destroy).toHaveBeenCalled()
  loadingDocument()
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await screen.findByText('Accessible PDF text')
  expect(screen.queryByRole('alert')).toBeNull()
  mocks.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('Invalid PDF structure')), destroy: vi.fn(async () => {}) })
  view.rerender(<ArtifactPdf {...props} revision={1}/>)
  expect((await screen.findByRole('alert')).textContent).toContain('Invalid PDF structure')
})

it('cancels rendering and prevents stale file reads or render completions from replacing the current document', async () => {
  let finishRead: (value: Uint8Array) => void = () => {}
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
  let finishRender: () => void = () => {}
  const { renders, task } = loadingDocument(new Promise<void>(resolve => { finishRender = resolve }))
  const view = render(<ArtifactPdf {...props}/>)
  view.rerender(<ArtifactPdf {...props} path="second.pdf"/>)
  await screen.findByRole('img', { name: 'PDF 第 1 页' })
  await act(async () => finishRead(new Uint8Array(65536)))
  expect(mocks.getDocument).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(renders[0].cancel).toHaveBeenCalled()
  expect(task.destroy).toHaveBeenCalled()
  await act(async () => finishRender())
  expect(screen.queryByText('Accessible PDF text')).toBeNull()
})
