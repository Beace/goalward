import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const baseUrl = process.env.GOALWARD_SMOKE_URL ?? 'http://127.0.0.1:1420'
const output = 'test-results/language-settings'
const labels = {
  zh: { settings: '设置', appearance: '外观', language: '界面语言', system: '跟随系统', save: '保存更改' },
  en: { settings: 'Settings', appearance: 'Appearance', language: 'Interface language', system: 'Follow system', save: 'Save changes' },
}
const htmlLang = { zh: 'zh-CN', en: 'en' }
const savedNotice = {
  zh: '配置已保存。外观立即生效；Runtime 配置用于下次执行，默认值用于新建成员。',
  en: 'Settings saved. Appearance changes apply now; runtime changes apply to the next run and defaults to new members.',
}

await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []

async function openAppearance(page, language) {
  await page.getByRole('button', { name: labels[language].settings, exact: true }).click()
  await page.getByRole('button', { name: labels[language].appearance, exact: true }).click()
  await expect(page.getByRole('button', { name: labels[language].appearance, exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: labels[language].appearance, exact: true })).toHaveCSS('background-color', 'rgb(48, 44, 39)')
  await expect(page.getByRole('combobox', { name: labels[language].language, exact: true })).toBeVisible()
  await expect(page.getByTestId('font-preview')).toContainText(language === 'zh'
    ? '让每个 Agent 专注于目标，让协作清晰可见。'
    : 'Keep every agent focused on the goal and every collaboration clear.')
}

async function selectLanguage(page, currentLanguage, optionName) {
  await page.getByRole('combobox', { name: labels[currentLanguage].language, exact: true }).click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

async function assertPage(page, language, issues) {
  await expect(page.locator('html')).toHaveAttribute('lang', htmlLang[language])
  const overflow = await page.evaluate(() => ({
    root: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    body: document.body.scrollWidth > document.documentElement.clientWidth,
  }))
  expect(overflow, `horizontal overflow: ${JSON.stringify(overflow)}`).toEqual({ root: false, body: false })
  expect(issues).toEqual([])
}

try {
  for (const locale of ['zh-CN', 'en-US', 'fr-FR']) {
    for (const [width, height] of [[1536, 960], [1280, 720]]) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ locale, viewport: { width, height }, reducedMotion })
        // The dev server has no favicon; keep that unrelated 404 out of UI error checks.
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }))
        const page = await context.newPage()
        const issues = []
        page.on('pageerror', error => issues.push(`pageerror: ${error.message}`))
        page.on('console', message => { if (message.type() === 'error') issues.push(`console ${message.location().url}: ${message.text()}`) })
        try {
          await page.goto(baseUrl)
          await page.evaluate(async () => {
            const { createInitialState } = await import('/src/lib/domain.ts')
            const state = createInitialState()
            state.onboarding = { version: 1, completedAt: new Date().toISOString(), outcome: 'configured' }
            delete state.settings.language
            localStorage.setItem('goalward.preview.v1', JSON.stringify(state))
          })
          await page.reload()

          const systemLanguage = locale === 'zh-CN' ? 'zh' : 'en'
          const manualLanguage = systemLanguage === 'zh' ? 'en' : 'zh'
          await assertPage(page, systemLanguage, issues)
          await openAppearance(page, systemLanguage)
          await expect(page.getByRole('combobox', { name: labels[systemLanguage].language, exact: true })).toContainText(labels[systemLanguage].system)

          await selectLanguage(page, systemLanguage, manualLanguage === 'zh' ? '中文' : 'English')
          await expect(page.locator('html')).toHaveAttribute('lang', htmlLang[systemLanguage])
          await page.getByRole('button', { name: labels[systemLanguage].save, exact: true }).click()
          await expect(page.locator('html')).toHaveAttribute('lang', htmlLang[manualLanguage])
          await expect(page.getByText(savedNotice[manualLanguage], { exact: true })).toBeVisible()
          await expect(page.getByTestId('font-preview')).toContainText(manualLanguage === 'zh'
            ? '让每个 Agent 专注于目标，让协作清晰可见。'
            : 'Keep every agent focused on the goal and every collaboration clear.')
          await expect(page.getByRole('combobox', { name: labels[manualLanguage].language, exact: true })).toContainText(manualLanguage === 'zh' ? '中文' : 'English')
          await assertPage(page, manualLanguage, issues)
          await page.screenshot({ path: `${output}/${locale}-${width}x${height}-${reducedMotion}-manual.png` })

          await page.reload()
          await assertPage(page, manualLanguage, issues)
          await openAppearance(page, manualLanguage)
          await expect(page.getByRole('combobox', { name: labels[manualLanguage].language, exact: true })).toContainText(manualLanguage === 'zh' ? '中文' : 'English')
          expect(await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.language)).toBe(manualLanguage)

          await selectLanguage(page, manualLanguage, labels[manualLanguage].system)
          await page.getByRole('button', { name: labels[manualLanguage].save, exact: true }).click()
          await assertPage(page, systemLanguage, issues)
          await expect(page.getByText(savedNotice[systemLanguage], { exact: true })).toBeVisible()
          await expect(page.getByTestId('font-preview')).toContainText(systemLanguage === 'zh'
            ? '让每个 Agent 专注于目标，让协作清晰可见。'
            : 'Keep every agent focused on the goal and every collaboration clear.')
          expect(await page.evaluate(() => JSON.parse(localStorage.getItem('goalward.preview.v1')).settings.language)).toBeUndefined()
          await page.reload()
          await assertPage(page, systemLanguage, issues)
          await openAppearance(page, systemLanguage)
          await expect(page.getByRole('combobox', { name: labels[systemLanguage].language, exact: true })).toContainText(labels[systemLanguage].system)
          await expect(page.getByRole('button', { name: labels[systemLanguage].save, exact: true })).toBeInViewport()
          await page.screenshot({ path: `${output}/${locale}-${width}x${height}-${reducedMotion}-system.png` })

          results.push({ locale, width, height, reducedMotion, systemLanguage, manualLanguage, manualOverridePersisted: true, systemChoiceRestored: true, horizontalOverflow: false, issues })
        } finally {
          await context.close()
        }
      }
    }
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
}
