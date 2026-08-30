import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// sample-a.pdf's 3 pages are solid red/green/blue (see engine/cmd/genfixtures) —
// exact, known colours make "did this pixel actually invert" a precise
// arithmetic check rather than a vague brightness threshold.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

async function pixelAt(page: import('@playwright/test').Page, alt: string, fx: number, fy: number) {
  const src = await page.getByAltText(alt).getAttribute('src')
  return page.evaluate(
    async ({ s, x, y }: { s: string; x: number; y: number }) => {
      const bmp = await createImageBitmap(await (await fetch(s)).blob())
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const px = Math.floor(x * bmp.width)
      const py = Math.floor(y * bmp.height)
      const d = ctx.getImageData(px, py, 1, 1).data
      return [d[0], d[1], d[2]]
    },
    { s: src!, x: fx, y: fy },
  )
}

test('inverts every page by default, and downloads a valid result', async ({ page }) => {
  await page.goto('/#/invert-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  await page.getByRole('radio', { name: /png/i }).check() // lossless — exact pixel check below

  const invertButton = page.getByRole('button', { name: /^invert$/i })
  await expect(invertButton).toBeEnabled()
  await invertButton.click()

  await expect(page.getByText(/^inverted ·/i)).toBeVisible({ timeout: 15_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const outPath = await download.path()
  expect(outPath).toBeTruthy()

  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)
  await page.getByRole('radio', { name: /^png$/i }).check()
  await page.getByRole('button', { name: /^convert$/i }).click()
  await expect(page.getByAltText('Page 1')).toBeVisible({ timeout: 15_000 })

  // Page 1 was solid RGBA{200, 40, 40} — inverted should read close to
  // {55, 215, 215}. A few units of slack for JPEG/PNG re-encode rounding.
  const [r, g, b] = await pixelAt(page, 'Page 1', 0.5, 0.5)
  expect(r).toBeLessThan(70)
  expect(g).toBeGreaterThan(195)
  expect(b).toBeGreaterThan(195)
})

test('a page left out of the selection keeps its original colour', async ({ page }) => {
  await page.goto('/#/invert-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  await page.getByRole('radio', { name: /png/i }).check()
  await page.getByRole('radio', { name: /selected pages/i }).check()
  await page.getByPlaceholder('1-3, 5').fill('1')

  const invertButton = page.getByRole('button', { name: /^invert$/i })
  await expect(invertButton).toBeEnabled()
  await invertButton.click()
  await expect(page.getByText(/^inverted ·/i)).toBeVisible({ timeout: 15_000 })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const outPath = await download.path()

  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)
  await page.getByRole('radio', { name: /^png$/i }).check()
  await page.getByRole('button', { name: /^convert$/i }).click()
  await expect(page.getByAltText('Page 2')).toBeVisible({ timeout: 15_000 })

  // Page 1 (selected) inverted; page 2 — RGBA{40, 160, 90} originally —
  // was left alone and should still read close to its original colour.
  const [r1] = await pixelAt(page, 'Page 1', 0.5, 0.5)
  const [r2, g2, b2] = await pixelAt(page, 'Page 2', 0.5, 0.5)
  expect(r1).toBeLessThan(70) // page 1 inverted (was red, now cyan-ish)
  expect(r2).toBeLessThan(70) // page 2 untouched — still its own dark-ish green
  expect(g2).toBeGreaterThan(130)
  expect(b2).toBeLessThan(130)
})

test('invert button is disabled until a selected-pages entry is valid', async ({ page }) => {
  await page.goto('/#/invert-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  await page.getByRole('radio', { name: /selected pages/i }).check()
  const invertButton = page.getByRole('button', { name: /^invert$/i })
  await expect(invertButton).toBeDisabled()

  await page.getByPlaceholder('1-3, 5').fill('99')
  await expect(page.getByText(/out of range/i)).toBeVisible()
  await expect(invertButton).toBeDisabled()

  await page.getByPlaceholder('1-3, 5').fill('1-2')
  await expect(invertButton).toBeEnabled()
})
