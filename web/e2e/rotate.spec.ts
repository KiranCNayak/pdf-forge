import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('rotates a PDF by a chosen angle and downloads it', async ({ page }) => {
  await page.goto('/#/rotate-pdf')

  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/sample-a\.pdf/)).toBeVisible()

  await page.getByRole('radio', { name: '180°' }).check()

  const rotateButton = page.getByRole('button', { name: /^rotate$/i })
  await expect(rotateButton).toBeEnabled()
  await rotateButton.click()

  await expect(page.getByText(/^rotated ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('rotated.pdf')
})

test('page selection field is disabled until "Selected pages" is chosen', async ({ page }) => {
  await page.goto('/#/rotate-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const selectionInput = page.getByPlaceholder('1-3, 5')
  await expect(selectionInput).toBeDisabled()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  await expect(selectionInput).toBeEnabled()

  const rotateButton = page.getByRole('button', { name: /^rotate$/i })
  await expect(rotateButton).toBeDisabled() // empty selection blocks the run

  await selectionInput.fill('1')
  await expect(rotateButton).toBeEnabled()
})
