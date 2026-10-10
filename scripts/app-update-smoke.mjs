import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const baseUrl = process.env.GOALWARD_SMOKE_URL ?? 'http://127.0.0.1:1421'
const output = 'test-results/app-update'
await mkdir(output, { recursive: true })
// This fixture renders the real component with controlled results. It cannot
// download, install, or restart a native app; those checks need signed releases.
await writeFile(`${output}/harness.html`, `<html><head></head><body><div id="root"></div><script type="module" src="./harness.jsx?smoke=${Date.now()}"></script></body></html>`)
await writeFile(`${output}/harness.jsx`, `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '/src/i18n.tsx'
import { AppUpdateSettings } from '/src/components/AppUpdateSettings.tsx'
import '/src/index.css'
function Harness() {
  const [state, setState] = useState({ phase: 'idle', info: { currentVersion: '0.2.0' }, downloadedBytes: 0 })
  const [blocked, setBlocked] = useState({ activeCount: 0, unsaved: false })
  window.updateSmoke = { ...window.updateSmoke, setState, setBlocked, calls: window.updateSmoke?.calls ?? [] }
  const operation = (stage, phase, success) => {
    window.updateSmoke.calls.push(stage)
    setState(s => ({ ...s, phase, error: undefined }))
    window.updateSmoke.complete = error => setState(s => error
      ? ({ ...s, phase: { check: 'idle', download: 'available', install: 'downloaded', restart: 'installed' }[stage], error: { stage, message: error } })
      : ({ ...s, ...success }))
  }
  const update = { ...state, desktop: true,
    check: async () => operation('check', 'checking', { phase: 'available', info: { currentVersion: '0.2.0', version: '0.3.0', releaseUrl: 'https://github.com/Beace/goalward/releases/tag/v0.3.0', notes: 'feat: GitHub Release app updates\\nfix: Preserve ongoing tasks' } }),
    download: async () => operation('download', 'downloading', { phase: 'downloaded' }),
    install: async () => operation('install', 'installing', { phase: 'installed' }),
    restart: async () => operation('restart', 'restarting', { phase: 'installed' }),
  }
  return <main className="bg-background text-foreground h-screen overflow-auto p-6"><div className="max-w-3xl"><AppUpdateSettings update={update} {...blocked} /></div></main>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Harness /></I18nProvider>)
`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const colorScheme of ['dark', 'light']) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme, reducedMotion })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        try {
          await page.goto(baseUrl)
          await page.evaluate(async () => {
            const { createInitialState } = await import('/src/lib/domain.ts')
            const state = createInitialState()
            state.settings.language = 'zh'
            state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
            localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
          })
          await page.reload()
          await page.getByRole('button', { name: '设置', exact: true }).click()
          await page.locator('#runtime-name').fill('未保存的 Runtime 草稿')
          await page.getByRole('button', { name: '应用更新', exact: true }).click()
          await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled()
          await expect(page.getByText(/浏览器提供界面预览；请在 macOS 桌面应用/)).toBeVisible()
          await page.getByRole('button', { name: '运行时', exact: true }).click()
          await expect(page.locator('#runtime-name')).toHaveValue('未保存的 Runtime 草稿')
          await page.getByRole('button', { name: '返回工作台', exact: true }).click()
          await expect(page.getByRole('dialog', { name: '放弃未保存的更改？' })).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('button', { name: '返回工作台', exact: true })).toBeFocused()

          await page.goto(`${baseUrl}/${output}/harness.html`)
          await page.evaluate(theme => document.documentElement.dataset.theme = theme, colorScheme)
          const check = page.getByRole('button', { name: '检查更新', exact: true })
          await check.focus()
          await page.keyboard.press('Enter')
          await expect(page.getByText('正在检查更新…', { exact: true })).toBeVisible()
          const spinning = await page.locator('[data-slot=spinner]').first().evaluate(el => getComputedStyle(el).animationName)
          expect(spinning).toBe(reducedMotion === 'reduce' ? 'none' : 'spin')
          await page.evaluate(() => window.updateSmoke.complete('Synthetic network timeout'))
          await expect(page.getByRole('alert')).toContainText('Synthetic network timeout')
          await expect(check).toBeEnabled()
          await check.click()
          await page.evaluate(() => window.updateSmoke.complete())
          await page.getByRole('button', { name: '下载更新', exact: true }).click()
          await page.evaluate(() => window.updateSmoke.setState(s => ({ ...s, downloadedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 })))
          await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
          const progressAnimation = await page.getByRole('progressbar').locator('[data-slot=progress-indicator]').evaluate(el => ({ transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration }))
          await page.evaluate(() => window.updateSmoke.complete('Synthetic signature rejected'))
          await expect(page.getByRole('button', { name: '重试下载', exact: true })).toBeEnabled()
          await expect(page.getByRole('button', { name: '安装更新', exact: true })).toHaveCount(0)
          await page.getByRole('button', { name: '重试下载', exact: true }).click()
          await page.evaluate(() => window.updateSmoke.complete())
          const install = page.getByRole('button', { name: '安装更新', exact: true })
          await page.evaluate(() => window.updateSmoke.setBlocked({ activeCount: 1, unsaved: false }))
          await expect(install).toBeDisabled()
          await page.evaluate(() => window.updateSmoke.setBlocked({ activeCount: 0, unsaved: true }))
          await expect(install).toBeDisabled()
          await page.evaluate(() => window.updateSmoke.setBlocked({ activeCount: 0, unsaved: false }))
          await install.click()
          await page.evaluate(() => window.updateSmoke.complete('Synthetic install permission denied'))
          await expect(page.getByRole('button', { name: '重试安装', exact: true })).toBeEnabled()
          await page.getByRole('button', { name: '重试安装', exact: true }).click()
          await page.evaluate(() => window.updateSmoke.complete())
          const restart = page.getByRole('button', { name: '重启并使用新版本', exact: true })
          await expect(restart).toBeEnabled()
          await page.evaluate(() => window.updateSmoke.setBlocked({ activeCount: 1, unsaved: false }))
          await expect(restart).toBeDisabled()
          await page.evaluate(() => window.updateSmoke.setBlocked({ activeCount: 0, unsaved: false }))
          await restart.click()
          await page.evaluate(() => window.updateSmoke.complete('Synthetic restart failure'))
          await expect(page.getByRole('button', { name: '重试重启', exact: true })).toBeEnabled()
          await expect(page.getByRole('button', { name: '下载更新', exact: true })).toHaveCount(0)
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
          expect(errors).toEqual([])
          await page.screenshot({ path: `${output}/${width}-${colorScheme}-${reducedMotion}.png` })
          results.push({ width, height, colorScheme, reducedMotion, spinning, progressAnimation, calls: await page.evaluate(() => window.updateSmoke.calls), nativeDownloadInstallVerified: false, errors })
        } finally { await context.close() }
      }
    }
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  console.log(`PASS: ${results.length} browser UI configurations; native boundary, drafts, keyboard/focus, loading CSS, progress and stage retries. Native download/install is not exercised.`)
} finally { await browser.close() }
