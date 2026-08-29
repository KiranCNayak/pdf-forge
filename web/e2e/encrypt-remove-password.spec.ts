import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Full round trip across two tools: encrypt a PDF with a password, then feed
// that exact downloaded file into Remove Password with the same password and
// confirm it unlocks. Exercises the acknowledge-checkbox gate, the download →
// re-upload path, and the wrong-password error branch — the same distinction
// docs/tools/remove-password.md calls out (missing vs. wrong password) and
// the browser smoke test also checks at the engine layer.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)
const PASSWORD = 'hunter2'

test('encrypt then remove-password round trip', async ({ page }) => {
  await page.goto('/#/encrypt-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  await page.getByLabel(/open password/i).fill(PASSWORD)
  await page.getByLabel(/understand this password cannot be recovered/i).check()

  const encryptButton = page.getByRole('button', { name: /^encrypt$/i })
  await expect(encryptButton).toBeEnabled()
  await encryptButton.click()

  await expect(page.getByText(/^encrypted ·/i)).toBeVisible()

  const [encryptedDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const encryptedPath = await encryptedDownload.path()
  expect(encryptedPath).toBeTruthy()

  await page.goto('/#/remove-password')
  const removeFileInput = page.locator('input[type="file"]')
  await expect(removeFileInput).toBeVisible() // lazy chunk load
  await removeFileInput.setInputFiles(encryptedPath!)

  await expect(page.getByPlaceholder('Password')).toBeVisible()

  // Wrong password first — confirm the distinct error, then the file is still there.
  await page.getByPlaceholder('Password').fill('wrong-password')
  await page.getByRole('button', { name: /^remove password$/i }).click()
  await expect(page.getByText(/wrong password/i)).toBeVisible()

  await page.getByPlaceholder('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /^remove password$/i }).click()

  await expect(page.getByText(/^password removed ·/i)).toBeVisible()

  const [unlockedDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(unlockedDownload.suggestedFilename()).toBe('unlocked.pdf')
})
