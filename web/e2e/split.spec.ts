import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// sample-a.pdf is 3 pages (see merge.spec.ts / smoke.ts's own "merge 3+2 pages" comment).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('splits every page into its own file', async ({ page }) => {
  await page.goto('/#/split-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const splitButton = page.getByRole('button', { name: /^split$/i })
  await expect(splitButton).toBeEnabled() // "every page" is the default mode
  await splitButton.click()

  await expect(page.getByText(/^3 files produced/i)).toBeVisible()
  const parts = page.locator('ol.files li')
  await expect(parts).toHaveCount(3)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    parts.first().getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBeTruthy()
})

test('ranges mode requires non-empty ranges text', async ({ page }) => {
  await page.goto('/#/split-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await page.getByRole('radio', { name: /by ranges/i }).check()
  const splitButton = page.getByRole('button', { name: /^split$/i })
  await expect(splitButton).toBeDisabled()

  await page.getByPlaceholder('1-3, 5, 7-10').fill('1-2')
  await expect(splitButton).toBeEnabled()
  await splitButton.click()

  await expect(page.getByText(/^1 file produced/i)).toBeVisible()
})
