import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('adds page numbers and downloads the result', async ({ page }) => {
  await page.goto('/#/page-numbers')

  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/sample-a\.pdf/)).toBeVisible()

  const runButton = page.getByRole('button', { name: /^add page numbers$/i })
  await expect(runButton).toBeEnabled() // a default format is always selected
  await runButton.click()

  await expect(page.getByText(/^numbered ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('numbered.pdf')
})

test('page selection field is disabled until "Selected pages" is chosen', async ({ page }) => {
  await page.goto('/#/page-numbers')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const selectionInput = page.getByPlaceholder('1-3, 5, even, odd')
  await expect(selectionInput).toBeDisabled()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  await expect(selectionInput).toBeEnabled()

  const runButton = page.getByRole('button', { name: /^add page numbers$/i })
  await expect(runButton).toBeDisabled() // empty selection blocks the run

  await selectionInput.fill('even')
  await expect(runButton).toBeEnabled()
})
