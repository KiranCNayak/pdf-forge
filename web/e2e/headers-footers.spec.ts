import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('applies a header and a footer via two chained calls and downloads it', async ({ page }) => {
  await page.goto('/#/headers-footers')

  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/sample-a\.pdf/)).toBeVisible()

  const runButton = page.getByRole('button', { name: /^apply$/i })
  await expect(runButton).toBeDisabled() // both fields empty blocks the run

  await page.getByPlaceholder(/document title/i).fill('CONFIDENTIAL')
  await page.getByPlaceholder(/© 2026/i).fill('Page %p0 of %P')
  await expect(runButton).toBeEnabled()
  await runButton.click()

  await expect(page.getByText(/^applied ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('with-header-footer.pdf')
})

test('only one field filled in still enables the run', async ({ page }) => {
  await page.goto('/#/headers-footers')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const runButton = page.getByRole('button', { name: /^apply$/i })
  await expect(runButton).toBeDisabled()

  await page.getByPlaceholder(/document title/i).fill('Just a header')
  await expect(runButton).toBeEnabled()

  await page.getByPlaceholder(/document title/i).fill('')
  await expect(runButton).toBeDisabled()

  await page.getByPlaceholder(/© 2026/i).fill('Just a footer')
  await expect(runButton).toBeEnabled()
})
