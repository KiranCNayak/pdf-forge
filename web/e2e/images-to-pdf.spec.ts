import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

test('combines staged images into one PDF, in order', async ({ page }) => {
  await page.goto('/#/images-to-pdf')

  // FilePicker defaults to "Drop PDFs here" wording unless overridden — this
  // tool must not regress to that default (see docs/tools/images-to-pdf.md's
  // Status section for the bug this caught during manual verification).
  await expect(page.getByText(/drop images here/i)).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles([fixture('portrait.png'), fixture('landscape.png')])

  const items = page.locator('ol.files li, ul.files li')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('portrait.png')

  await page.getByRole('radio', { name: /fit to image/i }).check()

  const createButton = page.getByRole('button', { name: /^create pdf$/i })
  await expect(createButton).toBeEnabled()
  await createButton.click()

  await expect(page.getByText(/^created ·/i)).toBeVisible()

  const downloadButton = page.getByRole('button', { name: /^download$/i })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
  expect(download.suggestedFilename()).toBe('images.pdf')
})

test('A4 page size reveals an orientation choice; fit hides it', async ({ page }) => {
  await page.goto('/#/images-to-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('portrait.png'))

  await expect(page.getByText(/^orientation$/i)).toHaveCount(0)

  await page.getByRole('radio', { name: /^a4$/i }).check()
  await expect(page.getByText(/^orientation$/i)).toBeVisible()

  await page.getByRole('radio', { name: /fit to image/i }).check()
  await expect(page.getByText(/^orientation$/i)).toHaveCount(0)
})
