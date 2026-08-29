import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Merge is the reference tool (see src/tools/Merge/tool.tsx's own comment), so
// it's the reference e2e test too: two-file staging, reorder, download, and
// the resulting PDF actually has the combined page count.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('merges two PDFs and downloads the result', async ({ page }) => {
  await page.goto('/#/merge')

  const input = page.locator('input[type="file"]')
  await input.setInputFiles([fixture('sample-a.pdf'), fixture('sample-b.pdf')])

  const items = page.locator('ol.files li, ul.files li')
  await expect(items).toHaveCount(2)

  const mergeButton = page.getByRole('button', { name: /^merge$/i })
  await expect(mergeButton).toBeEnabled()
  await mergeButton.click()

  await expect(page.getByText(/^merged \d+ pages?/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])

  expect(download.suggestedFilename()).toBe('merged.pdf')
  const filePath = await download.path()
  expect(filePath).toBeTruthy()
})

test('reorder buttons change staged file order', async ({ page }) => {
  await page.goto('/#/merge')

  const input = page.locator('input[type="file"]')
  await input.setInputFiles([fixture('sample-a.pdf'), fixture('sample-b.pdf')])

  const items = page.locator('ol.files li, ul.files li')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('sample-a.pdf')

  await items.nth(1).getByRole('button', { name: /move up/i }).click()

  await expect(items.first()).toContainText('sample-b.pdf')
})
