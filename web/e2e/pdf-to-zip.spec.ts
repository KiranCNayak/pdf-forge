import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('multi-page PDF renders into a ZIP', async ({ page }) => {
  await page.goto('/#/pdf-to-zip')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/^sample-a\.pdf/)).toBeVisible()

  await page.locator('select').selectOption('72') // fastest render, pipeline is what's tested

  const convertButton = page.getByRole('button', { name: /^convert$/i })
  await expect(convertButton).toBeEnabled()
  await convertButton.click()

  await expect(page.getByText(/^zip ready/i)).toBeVisible({ timeout: 15_000 })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('sample-a.zip')
})

test('single-page document skips the ZIP and hands back the image directly', async ({ page }) => {
  await page.goto('/#/pdf-to-zip')
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, 'fixtures', 'text-page.pdf'))
  await expect(page.getByText(/1 page/i)).toBeVisible()
  await expect(page.getByText(/no zip/i)).toBeVisible()

  await page.locator('select').selectOption('72')
  await page.getByRole('button', { name: /^convert$/i }).click()

  await expect(page.getByText(/^page 1 rendered/i)).toBeVisible({ timeout: 15_000 })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('text-page-p1.jpg')
})
