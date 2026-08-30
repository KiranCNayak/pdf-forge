import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

// Redact is the highest-stakes tool in the app — see docs/tools/redact.md.
// This spec's job is to prove the actual security property, not just that
// the UI wires up: the raw output PDF bytes must never contain the secret
// text anywhere (not just under the box — nowhere in the whole file), and
// content outside the box must still be visually present, not blanked out
// wholesale. "e2e/fixtures/redact-secret.pdf" (built by
// `go run ./cmd/genfixtures -redact`) has two real vector-text stamps,
// bottom-left ("SECRET-9F3A1B47") and top-right ("PUBLIC-KEEP-VISIBLE").

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const secretFixture = path.join(__dirname, 'fixtures', 'redact-secret.pdf')

// Draws a box over the given fractional rectangle of the canvas's own
// bounding box — resolution-independent of whatever CSS scaling the browser
// window applies, same reasoning as the tool's own toCanvasCoords.
async function dragBox(page: import('@playwright/test').Page, x0: number, y0: number, x1: number, y1: number) {
  const canvas = page.locator('canvas')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas not visible')
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 8 })
  await page.mouse.up()
}

test('drawing and removing boxes updates the on-page count', async ({ page }) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(secretFixture)
  await expect(page.locator('canvas')).toBeVisible()

  await expect(page.getByText(/0 boxes/i)).toBeVisible()
  await dragBox(page, 0.1, 0.6, 0.5, 0.9)
  await expect(page.getByText(/1 box\b/i)).toBeVisible()

  await page.getByRole('button', { name: /^remove box 1$/i }).click()
  await expect(page.getByText(/0 boxes/i)).toBeVisible()
})

test('a drag smaller than the accidental-click threshold is ignored', async ({ page }) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(secretFixture)
  await expect(page.locator('canvas')).toBeVisible()

  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box!.x + 10, box!.y + 10)
  await page.mouse.down()
  await page.mouse.move(box!.x + 11, box!.y + 11)
  await page.mouse.up()

  await expect(page.getByText(/0 boxes/i)).toBeVisible()
})

test('redact button is disabled until at least one box is drawn', async ({ page }) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(secretFixture)
  await expect(page.locator('canvas')).toBeVisible()

  const redactButton = page.getByRole('button', { name: /^redact$/i })
  await expect(redactButton).toBeDisabled()

  await dragBox(page, 0.1, 0.6, 0.5, 0.9)
  await expect(redactButton).toBeEnabled()
})

test('"Redact Entire Page" fills the whole canvas with one box', async ({ page }) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(secretFixture)
  await expect(page.locator('canvas')).toBeVisible()

  await page.getByRole('button', { name: /^redact entire page$/i }).click()
  await expect(page.getByText(/1 box\b/i)).toBeVisible()
  await expect(page.getByText(/box 1: 0%,0% → 100%,100%/i)).toBeVisible()
})

test('the secret text never survives redaction anywhere in the output file, and untouched content is still visible', async ({
  page,
}) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(secretFixture)
  await expect(page.getByText(/1 page/i)).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  // Bottom-left quadrant only — comfortably covers "SECRET-9F3A1B47" without
  // touching "PUBLIC-KEEP-VISIBLE" in the opposite corner.
  await dragBox(page, 0.05, 0.6, 0.55, 0.95)
  await expect(page.getByText(/1 box\b/i)).toBeVisible()

  const redactButton = page.getByRole('button', { name: /^redact$/i })
  await expect(redactButton).toBeEnabled()
  await redactButton.click()

  await expect(page.getByText(/^redacted ·/i)).toBeVisible({ timeout: 30_000 })

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^download$/i }).click()])
  const outPath = await download.path()
  expect(outPath).toBeTruthy()

  // The decisive check: read the RAW output bytes and confirm the secret
  // string is not present anywhere in the file — not in a content stream,
  // not in metadata, not in an incremental-update remnant. This is only
  // possible to assert with confidence because the whole document was
  // rebuilt from rasterized images: there is no code path left that could
  // carry the original string across as text.
  const raw = await fs.readFile(outPath!)
  expect(raw.includes('9F3A1B47')).toBe(false)
  // The rest of the original document's OWN text is gone too — that's the
  // documented trade-off, not a separate bug — but worth asserting so a
  // future change that makes redaction "smarter" (leaves some vector text
  // in place) doesn't silently reintroduce the original leak vector.
  expect(raw.includes('PUBLIC-KEEP-VISIBLE')).toBe(false)

  // Visual check: render the output back through the app's own PdfToImage
  // tool (a second, independent code path) and sample two pixels — one well
  // inside the drawn box (must be black) and one at the untouched page
  // centre (must not be black) — proving the redaction is localized, not a
  // blanket black page.
  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)

  // PdfToImage defaults to JPEG; switch to PNG so the pixel sampling below
  // isn't reading lossy-compressed values near the box edge.
  await page.getByRole('radio', { name: /^png$/i }).check()

  const convertButton = page.getByRole('button', { name: /^convert$/i })
  await expect(convertButton).toBeEnabled()
  await convertButton.click()

  const img = page.getByAltText('Page 1')
  await expect(img).toBeVisible({ timeout: 30_000 })
  const src = await img.getAttribute('src')

  const [boxPixel, centerPixel] = await page.evaluate(async (imgSrc: string) => {
    const res = await fetch(imgSrc)
    const blob = await res.blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const sample = (fx: number, fy: number) => {
      const x = Math.min(bitmap.width - 1, Math.floor(fx * bitmap.width))
      const y = Math.min(bitmap.height - 1, Math.floor(fy * bitmap.height))
      const d = ctx.getImageData(x, y, 1, 1).data
      return [d[0], d[1], d[2]]
    }
    return [sample(0.3, 0.8), sample(0.5, 0.5)]
  }, src!)

  const brightness = (rgb: number[]) => (rgb[0] + rgb[1] + rgb[2]) / 3
  expect(brightness(boxPixel)).toBeLessThan(20) // inside the drawn box: solid black
  expect(brightness(centerPixel)).toBeGreaterThan(200) // untouched page centre: white background
})
