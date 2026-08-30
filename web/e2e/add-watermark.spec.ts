import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('stamps text onto every page and downloads it', async ({ page }) => {
  await page.goto('/#/add-watermark')

  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/sample-a\.pdf/)).toBeVisible()

  const runButton = page.getByRole('button', { name: /^add watermark$/i })
  await expect(runButton).toBeDisabled() // empty text blocks the run

  await page.getByPlaceholder(/draft, confidential/i).fill('DRAFT')
  await expect(runButton).toBeEnabled()
  await runButton.click()

  await expect(page.getByText(/^watermarked ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('watermarked.pdf')
})

test('page selection field is disabled until "Selected pages" is chosen', async ({ page }) => {
  await page.goto('/#/add-watermark')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await page.getByPlaceholder(/draft, confidential/i).fill('DRAFT')

  const selectionInput = page.getByPlaceholder('1-3, 5')
  await expect(selectionInput).toBeDisabled()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  await expect(selectionInput).toBeEnabled()

  const runButton = page.getByRole('button', { name: /^add watermark$/i })
  await expect(runButton).toBeDisabled() // empty selection blocks the run

  await selectionInput.fill('1')
  await expect(runButton).toBeEnabled()
})
