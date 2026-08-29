import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('compresses a PDF with the default preset and downloads it', async ({ page }) => {
  await page.goto('/#/compress-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const compressButton = page.getByRole('button', { name: /^compress$/i })
  await expect(compressButton).toBeEnabled()
  await compressButton.click()

  // sample-a.pdf carries no compressible images, so this always lands on the
  // fallback/no-gain path — the point here is the pipeline completes and a
  // real download comes out, not the compression ratio.
  const resultRow = page.locator('.result ol.files li').first()
  await expect(resultRow).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    resultRow.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('sample-a-compressed.pdf')
})

test('target-size mode is blocked at zero or negative', async ({ page }) => {
  await page.goto('/#/compress-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await page.getByRole('radio', { name: /target size/i }).check()
  const targetInput = page.getByLabel(/get under/i)
  await targetInput.fill('0')

  await expect(page.getByRole('button', { name: /^compress$/i })).toBeDisabled()

  await targetInput.fill('2')
  await expect(page.getByRole('button', { name: /^compress$/i })).toBeEnabled()
})
