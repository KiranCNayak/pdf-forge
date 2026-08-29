import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('renders every page to JPG and downloads one', async ({ page }) => {
  await page.goto('/#/pdf-to-jpg')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/^sample-a\.pdf/)).toBeVisible()

  // Lowest DPI available, to keep the render fast — the point of this test is
  // the pipeline (open → renderPage × N → done), not image fidelity.
  await page.locator('select').selectOption('72')

  const convertButton = page.getByRole('button', { name: /^convert$/i })
  await expect(convertButton).toBeEnabled()
  await convertButton.click()

  await expect(page.getByText(/^3 images rendered/i)).toBeVisible({ timeout: 15_000 })

  const rows = page.locator('li').filter({ hasText: /^Page \d/ })
  await expect(rows).toHaveCount(3)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    rows.first().getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('sample-a-p1.jpg')
})

test('selected-pages mode blocks the run until a valid selection is entered', async ({ page }) => {
  await page.goto('/#/pdf-to-jpg')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/^sample-a\.pdf/)).toBeVisible()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  const convertButton = page.getByRole('button', { name: /^convert$/i })
  await expect(convertButton).toBeDisabled()

  await page.getByPlaceholder('1-3, 5').fill('1-2')
  await expect(convertButton).toBeEnabled()
})
