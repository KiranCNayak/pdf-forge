import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('detects sample-a.pdf as scanned (image-only, no text layer)', async ({ page }) => {
  await page.goto('/#/extract-text')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const extractButton = page.getByRole('button', { name: /^extract text$/i })
  await expect(extractButton).toBeEnabled()
  await extractButton.click()

  // sample-a.pdf's own documented shape (see docs/STATE.md's PdfToImage/ExtractText
  // rows): image-only, no text layer — must be explained, not silently empty.
  await expect(page.getByText(/looks like a scanned document/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^copy all$/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^download \.txt$/i })).toHaveCount(0)
})

test('extracts real text and offers copy and download', async ({ page }) => {
  await page.goto('/#/extract-text')
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, 'fixtures', 'text-page.pdf'))
  await expect(page.getByText(/1 page/i)).toBeVisible()

  await page.getByRole('button', { name: /^extract text$/i }).click()

  await expect(page.getByText(/looks like a scanned document/i)).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('pre')).toContainText('Hello from pdf-forge e2e tests')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download \.txt$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('text-page.txt')
})
