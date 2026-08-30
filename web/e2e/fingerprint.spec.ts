import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('stamps a unique code and it survives as real, extractable text in the raw file', async ({ page }) => {
  await page.goto('/#/fingerprint-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  await page.getByPlaceholder(/jane@example.com/i).fill('legal-team')

  const runButton = page.getByRole('button', { name: /^fingerprint$/i })
  await expect(runButton).toBeEnabled()
  await runButton.click()

  await expect(page.getByText(/^fingerprinted ·/i)).toBeVisible({ timeout: 15_000 })
  const codeText = await page.locator('code').last().textContent()
  const code = codeText!.trim()
  // "legal-team-XXXXXX" — the random suffix makes every run's code unique,
  // so this also proves the label made it into the final string, not just
  // the random half.
  expect(code).toMatch(/^legal-team-[0-9A-F]{6}$/)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const outPath = await download.path()
  expect(outPath).toBeTruthy()

  // The decisive check: the exact generated code is present as raw,
  // uncompressed... no — pdfcpu's content streams are Flate-compressed, so
  // this can't be a literal byte search the way redact.spec.ts's ABSENCE
  // check can. Verify presence via the app's own ExtractText tool instead —
  // a second, independent code path that decompresses and reads real text.
  await page.goto('/#/extract-text')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)
  await page.getByRole('button', { name: /^extract text$/i }).click()
  await expect(page.locator('pre')).toContainText(code, { timeout: 15_000 })
})

test('a blank label still produces a unique random code', async ({ page }) => {
  await page.goto('/#/fingerprint-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const runButton = page.getByRole('button', { name: /^fingerprint$/i })
  await expect(runButton).toBeEnabled()
  await runButton.click()

  await expect(page.getByText(/^fingerprinted ·/i)).toBeVisible({ timeout: 15_000 })
  const codeText = await page.locator('code').last().textContent()
  expect(codeText!.trim()).toMatch(/^[0-9A-F]{6}$/)
})
