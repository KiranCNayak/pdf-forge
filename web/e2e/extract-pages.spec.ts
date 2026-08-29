import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('extracts a page selection and downloads it', async ({ page }) => {
  await page.goto('/#/extract-pages')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const extractButton = page.getByRole('button', { name: /^extract$/i })
  await expect(extractButton).toBeDisabled() // empty selection blocks the run

  await page.getByPlaceholder('1-3, 5, 8-12').fill('1-2')
  await expect(extractButton).toBeEnabled()
  await extractButton.click()

  await expect(page.getByText(/^extracted/i)).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('extracted.pdf')
})
