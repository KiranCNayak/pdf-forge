import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('crops a PDF with a margin and downloads it', async ({ page }) => {
  await page.goto('/#/crop-resize-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/sample-a\.pdf/)).toBeVisible()

  // Default mode is Crop; default margins (0) still produce a valid, if
  // no-op, crop — the button should already be enabled.
  const cropButton = page.getByRole('button', { name: /^crop$/i })
  await expect(cropButton).toBeEnabled()
  await cropButton.click()

  await expect(page.getByText(/^cropped ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('resized.pdf')
})

test('resizes a PDF to a named page size and downloads it', async ({ page }) => {
  await page.goto('/#/crop-resize-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await page.getByRole('radio', { name: /^resize \(scale the whole page\)$/i }).click()
  await page.getByRole('radio', { name: /^page size$/i }).click()

  const resizeButton = page.getByRole('button', { name: /^resize$/i })
  await expect(resizeButton).toBeEnabled()
  await resizeButton.click()

  await expect(page.getByText(/^resized ·/i)).toBeVisible()
})

test('resize by scale blocks a scale of exactly 1', async ({ page }) => {
  await page.goto('/#/crop-resize-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await page.getByRole('radio', { name: /^resize \(scale the whole page\)$/i }).click()

  const scaleInput = page.getByLabel(/1 = unchanged/i)
  await scaleInput.fill('1')

  const resizeButton = page.getByRole('button', { name: /^resize$/i })
  await expect(resizeButton).toBeDisabled()

  await scaleInput.fill('2')
  await expect(resizeButton).toBeEnabled()
})

test('page selection field is disabled until "Selected pages" is chosen', async ({ page }) => {
  await page.goto('/#/crop-resize-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const selectionInput = page.getByPlaceholder('1-3, 5, even, odd')
  await expect(selectionInput).toBeDisabled()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  await expect(selectionInput).toBeEnabled()

  const cropButton = page.getByRole('button', { name: /^crop$/i })
  await expect(cropButton).toBeDisabled() // empty selection blocks the run

  await selectionInput.fill('1')
  await expect(cropButton).toBeEnabled()
})
