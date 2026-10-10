// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.desktop, invoke: native.invoke }))
beforeEach(() => { native.desktop = true; native.invoke.mockReset(); vi.resetModules() })

it('passes explicit oversized-file approval through IPC and keeps the default gated', async () => {
  native.invoke.mockResolvedValue({ path: '/workspace/large.pdf', content: '', bytes: 524288001, tooLarge: true })
  const { readArtifact } = await import('./bridge')
  expect((await readArtifact('/workspace', 'large.pdf')).tooLarge).toBe(true)
  expect(native.invoke).toHaveBeenLastCalledWith('read_artifact', { directory: '/workspace', path: 'large.pdf', allowLarge: false })
  await readArtifact('/workspace', 'large.pdf', true)
  expect(native.invoke).toHaveBeenLastCalledWith('read_artifact', { directory: '/workspace', path: 'large.pdf', allowLarge: true })
})

it('preserves PDF bytes from native binary responses and browser fixture arrays', async () => {
  const bytes = [37, 80, 68, 70, 45, 0, 255]
  native.invoke.mockResolvedValueOnce(new Uint8Array(bytes).buffer).mockResolvedValueOnce(bytes)
  const { readArtifactPdfChunk } = await import('./bridge')
  expect([...await readArtifactPdfChunk('/workspace', 'report.pdf', 0, bytes.length)]).toEqual(bytes)
  expect(native.invoke).toHaveBeenLastCalledWith('read_artifact_pdf_chunk', { directory: '/workspace', path: 'report.pdf', offset: 0, length: bytes.length, allowLarge: false })
  expect([...await readArtifactPdfChunk('/workspace', 'large.pdf', 12, bytes.length, true)]).toEqual(bytes)
  expect(native.invoke).toHaveBeenLastCalledWith('read_artifact_pdf_chunk', { directory: '/workspace', path: 'large.pdf', offset: 12, length: bytes.length, allowLarge: true })
})

it('does not try local PDF IPC outside the desktop app', async () => {
  native.desktop = false
  const { readArtifactPdfChunk } = await import('./bridge')
  await expect(readArtifactPdfChunk('/workspace', 'report.pdf', 0, 16)).rejects.toThrow('桌面应用')
  expect(native.invoke).not.toHaveBeenCalled()
})
