import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Full round trip across two tools: stamp a watermark onto a PDF, then feed
// that exact downloaded file into Remove Watermark and confirm it detects
// and strips it. Same shape as encrypt-remove-password.spec.ts's round trip.
// See docs/tools/{add-watermark,remove-watermark}.md.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('add watermark then remove watermark round trip', async ({ page }) => {
  await page.goto('/#/add-watermark')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await page.getByPlaceholder(/draft, confidential/i).fill('DRAFT')

  const addButton = page.getByRole('button', { name: /^add watermark$/i })
  await expect(addButton).toBeEnabled()
  await addButton.click()

  await expect(page.getByText(/^watermarked ·/i)).toBeVisible()

  const [watermarkedDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const watermarkedPath = await watermarkedDownload.path()
  expect(watermarkedPath).toBeTruthy()

  await page.goto('/#/remove-watermark')
  const removeFileInput = page.locator('input[type="file"]')
  await expect(removeFileInput).toBeVisible() // lazy chunk load
  await removeFileInput.setInputFiles(watermarkedPath!)

  await expect(page.getByText(/^watermark detected\.?$/i)).toBeVisible()

  const removeButton = page.getByRole('button', { name: /^remove watermark$/i })
  await expect(removeButton).toBeEnabled()
  await removeButton.click()

  await expect(page.getByText(/^watermark removed ·/i)).toBeVisible()

  const [strippedDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(strippedDownload.suggestedFilename()).toBe('unwatermarked.pdf')
})

test('a file with no watermark is a harmless no-op, not a blocked button', async ({ page }) => {
  await page.goto('/#/remove-watermark')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await expect(page.getByText(/no watermark detected/i)).toBeVisible()

  const removeButton = page.getByRole('button', { name: /^remove watermark$/i })
  await expect(removeButton).toBeEnabled()
  await removeButton.click()

  await expect(page.getByText(/^watermark removed ·/i)).toBeVisible()
})
