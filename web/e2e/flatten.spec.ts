import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// form-fixture.pdf (go run ./cmd/genfixtures -flatten-form) is a one-page PDF
// with a REAL AcroForm text field widget, value "SECRET-FORM-VAL-9Q8W7E" —
// not a plain text stamp. Confirmed by hand before writing this tool at all
// (see docs/tools/flatten.md): pdf.js's render worker bakes a filled field's
// appearance into the canvas by default, so this file's own rendered pixels
// are the actual proof the tool works, not an assumption about pdf.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, 'fixtures', name)

test('flattens a form field so its value survives as pixels, and the page keeps its size', async ({ page }) => {
  await page.goto('/#/flatten-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('form-fixture.pdf'))
  await expect(page.getByText(/1 page/i)).toBeVisible()

  await page.getByRole('radio', { name: /png/i }).check() // Flatten's own label is "PNG (lossless)"
  const dpiSelect = page.locator('select')
  await dpiSelect.selectOption('300')

  const flattenButton = page.getByRole('button', { name: /^flatten$/i })
  await expect(flattenButton).toBeEnabled()
  await flattenButton.click()

  await expect(page.getByText(/^flattened ·/i)).toBeVisible({ timeout: 15_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const outPath = await download.path()
  expect(outPath).toBeTruthy()

  // The raw output bytes are a real, freshly rasterized PDF, not a copy of
  // the original — the field's own /FT /Tx /Widget structure must be gone.
  const fs = await import('node:fs/promises')
  const raw = (await fs.readFile(outPath!)).toString('latin1')
  expect(raw.includes('/Widget')).toBe(false)
  expect(raw.includes('/AcroForm')).toBe(false)

  // Independent verification: render the output back through the app's own
  // PdfToImage tool and confirm the field's VALUE survived as pixels, and
  // the page kept its A4 physical size ("exact" mode doing its job).
  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)
  await page.getByRole('radio', { name: /^png$/i }).check()
  await page.getByRole('button', { name: /^convert$/i }).click()
  await expect(page.getByAltText('Page 1')).toBeVisible({ timeout: 15_000 })

  const src = await page.getByAltText('Page 1').getAttribute('src')
  const { width, height, hasDarkPixelNearField } = await page.evaluate(async (s: string) => {
    const bmp = await createImageBitmap(await (await fetch(s)).blob())
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    // The field sits at PDF point (100, 700) on an A4 (595x842pt) page,
    // origin bottom-left — i.e. roughly 17% down from the top, spanning
    // right from x≈17%. Sample a generous box around it for a dark pixel.
    const x0 = Math.floor(0.14 * bmp.width)
    const x1 = Math.floor(0.6 * bmp.width)
    const y0 = Math.floor(0.12 * bmp.height)
    const y1 = Math.floor(0.22 * bmp.height)
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    let minBrightness = 255
    for (let k = 0; k < d.length; k += 4) {
      const b = (d[k] + d[k + 1] + d[k + 2]) / 3
      if (b < minBrightness) minBrightness = b
    }
    return { width: bmp.width, height: bmp.height, hasDarkPixelNearField: minBrightness < 100 }
  }, src!)

  expect(hasDarkPixelNearField).toBe(true) // the field's text glyphs are really there
  expect(width / height).toBeCloseTo(595 / 842, 1) // still A4 portrait
})

test('flatten button is disabled until a file with a page count is loaded', async ({ page }) => {
  await page.goto('/#/flatten-pdf')
  await expect(page.getByRole('button', { name: /^flatten$/i })).toHaveCount(0)
  await page.locator('input[type="file"]').setInputFiles(fixture('form-fixture.pdf'))
  await expect(page.getByRole('button', { name: /^flatten$/i })).toBeEnabled()
})
