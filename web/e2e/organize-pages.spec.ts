import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Drag-reorder isn't exercised here — dispatching real HTML5 DragEvents from
// Playwright has the same reliability problems noted in docs/STATE.md for the
// Chrome-extension manual verification of this tool. Rotate/duplicate/delete/
// undo/redo/apply cover the intent-list mechanics (the actual new surface —
// see organize-pages.md) via ordinary button clicks instead.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

test('rotate, duplicate, undo, and apply update the intent list correctly', async ({ page }) => {
  await page.goto('/#/organize-pages')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const cards = page.locator('main ul li') // scoped past <nav>'s own <ul> lists
  await expect(cards).toHaveCount(3)

  const applyButton = page.getByRole('button', { name: /^apply$/i })
  await expect(applyButton).toBeDisabled() // nothing changed yet

  await cards.first().getByRole('button', { name: 'Rotate' }).click()
  await expect(cards.first()).toContainText('90°')
  await expect(applyButton).toBeEnabled()

  await page.getByRole('button', { name: /^undo$/i }).click()
  await expect(cards.first()).not.toContainText('90°')
  await expect(applyButton).toBeDisabled() // back to the identity arrangement

  await page.getByRole('button', { name: /^redo$/i }).click()
  await expect(cards.first()).toContainText('90°')

  await cards.nth(1).getByRole('button', { name: 'Duplicate' }).click()
  await expect(cards).toHaveCount(4)

  await applyButton.click()
  await expect(page.getByText(/^applied ·/i)).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe('organized.pdf')
})

test('deleting every page blocks Apply with a clear error', async ({ page }) => {
  await page.goto('/#/organize-pages')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))

  const cards = page.locator('main ul li') // scoped past <nav>'s own <ul> lists
  await expect(cards).toHaveCount(3)

  for (let i = 0; i < 3; i++) {
    await cards.first().getByRole('button', { name: 'Delete' }).click()
  }

  await expect(cards).toHaveCount(0)
  await expect(page.getByText(/every page is deleted/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /^apply$/i })).toBeDisabled()
})
