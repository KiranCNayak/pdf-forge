import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

// Adversarial companion to redact.spec.ts. Where that spec proves the basic
// property on a plain one-page fixture, this one attacks the geometry and the
// state machine: a /Rotate 90 page (does the box the user drew over the
// ALREADY-ROTATED preview land on the same content in the higher-DPI output
// pass?), a five-page document with boxes on non-contiguous pages (does the
// page→box mapping and the page ORDER survive?), an encrypted source (does
// the password → render → redact pipeline rasterize the REAL content rather
// than a blank that merely looks redacted?), and a mixed-page-size document,
// which is the only thing that exercises the per-page `imagesToPDF` + `merge`
// fallback branch — previously the one path docs/tools/redact.md flagged as
// having no automated coverage at all.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fx = (n: string) => path.join(__dirname, 'fixtures', n)

async function dragBox(page: Page, x0: number, y0: number, x1: number, y1: number) {
  const canvas = page.locator('canvas')
  await canvas.scrollIntoViewIfNeeded()
  const b = await canvas.boundingBox()
  if (!b) throw new Error('canvas not visible')
  await page.mouse.move(b.x + b.width * x0, b.y + b.height * y0)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 8 })
  await page.mouse.up()
}

async function runRedact(page: Page): Promise<string> {
  const redact = page.getByRole('button', { name: /^redact$/i })
  await expect(redact).toBeEnabled()
  await redact.click()
  await expect(page.getByText(/^redacted ·/i)).toBeVisible({ timeout: 120_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const p = await download.path()
  expect(p).toBeTruthy()
  return p!
}

/** Renders a PDF through the app's own PdfToImage tool — a second, independent
 * code path — and returns one descriptor per page. */
async function renderPages(page: Page, file: string): Promise<{ src: string; w: number; h: number }[]> {
  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  // PdfToImage is a lazily-loaded route chunk — without this wait,
  // setInputFiles can fire before the real <input> has mounted, and the
  // upload silently never lands (same pattern redact.spec.ts already
  // guards against for its own cross-tool navigation).
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(file)
  await page.getByRole('radio', { name: /^png$/i }).check()
  await page.getByRole('button', { name: /^convert$/i }).click()
  await expect(page.getByAltText('Page 1')).toBeVisible({ timeout: 120_000 })
  const srcs = await page
    .locator('img[alt^="Page "]')
    .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))
  const out: { src: string; w: number; h: number }[] = []
  for (const src of srcs) {
    const { w, h } = await page.evaluate(async (s: string) => {
      const bmp = await createImageBitmap(await (await fetch(s)).blob())
      return { w: bmp.width, h: bmp.height }
    }, src)
    out.push({ src, w, h })
  }
  return out
}

/** Min and max brightness over a fractional rectangle of a rendered page.
 * A single-pixel sample is too fragile for thin vector text — `min` is what
 * says "there is dark content here", `max` is what says "this is solid black". */
async function region(page: Page, src: string, x0: number, y0: number, x1: number, y1: number) {
  return page.evaluate(
    async ({ s, r }: { s: string; r: number[] }) => {
      const bmp = await createImageBitmap(await (await fetch(s)).blob())
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const x = Math.floor(r[0] * bmp.width)
      const y = Math.floor(r[1] * bmp.height)
      const w = Math.max(1, Math.floor((r[2] - r[0]) * bmp.width))
      const h = Math.max(1, Math.floor((r[3] - r[1]) * bmp.height))
      const d = ctx.getImageData(x, y, w, h).data
      let min = 255
      let max = 0
      for (let k = 0; k < d.length; k += 4) {
        const b = (d[k] + d[k + 1] + d[k + 2]) / 3
        if (b < min) min = b
        if (b > max) max = b
      }
      return { min, max }
    },
    { s: src, r: [x0, y0, x1, y1] },
  )
}

// --------------------------------------------------------------- geometry

test('a /Rotate 90 page redacts the region the user actually drew over', async ({ page }) => {
  test.setTimeout(180_000)
  // adv-rot90.pdf is a portrait Letter page with "SECRET-ROT90AA" bottom-left
  // and "PUBLIC-ROT90BB" top-right, then /Rotate 90. Rendered, that puts the
  // secret down the LEFT edge (upper half) of a landscape page and the public
  // string down the right edge (lower half). If the preview pass (110 DPI)
  // and the output pass (200 DPI) disagreed about rotation in any way, the
  // box would land on the wrong content — which is exactly what the two
  // assertions at the end catch, in both directions.
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-rot90.pdf'))
  await expect(page.locator('canvas')).toBeVisible()

  // The preview canvas must itself be landscape — proof /Rotate reached it.
  const cb = await page.locator('canvas').boundingBox()
  expect(cb!.width).toBeGreaterThan(cb!.height)

  await dragBox(page, 0.01, 0.02, 0.16, 0.58)
  const outPath = await runRedact(page)

  const raw = await fs.readFile(outPath)
  expect(raw.includes('ROT90AA')).toBe(false)
  expect(raw.includes('ROT90BB')).toBe(false)

  const pages = await renderPages(page, outPath)
  expect(pages).toHaveLength(1)
  // Page stayed landscape — "exact" mode carried the rotated physical size.
  expect(pages[0].w).toBeGreaterThan(pages[0].h)

  // Where the secret was: solid black, no lighter pixel anywhere in it.
  const covered = await region(page, pages[0].src, 0.03, 0.06, 0.13, 0.5)
  expect(covered.max).toBeLessThan(20)
  // Where the public string was: untouched, and still carrying real dark
  // glyph pixels. If the box had landed here instead (a rotation mismatch),
  // this would be black; if the whole page had been blanked, it would be white.
  const spared = await region(page, pages[0].src, 0.87, 0.5, 0.99, 0.97)
  expect(spared.min).toBeLessThan(160)
  expect(spared.max).toBeGreaterThan(200)
})

test('boxes on non-contiguous pages map to the right pages, in the right order', async ({ page }) => {
  test.setTimeout(240_000)
  // adv-multi5.pdf: five identical pages, each stamped at its centre with its
  // own page number ("PAGE1SECRET-M1X" … "PAGE5SECRET-M5X"). Boxes go on
  // pages 1, 3 and 5 — first, middle and last, non-contiguous — so a
  // page→box mapping bug or a reordering bug both show up as a black centre
  // on the wrong page.
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-multi5.pdf'))
  await expect(page.getByText(/5 pages/i)).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  for (const target of [1, 3, 5]) {
    while (Number((await page.getByText(/Page \d+\/5/).textContent())!.match(/Page (\d+)/)![1]) < target) {
      await page.getByRole('button', { name: /^next$/i }).click()
      await expect(page.locator('canvas')).toBeVisible()
    }
    await dragBox(page, 0.15, 0.4, 0.85, 0.6)
  }
  await expect(page.getByText(/Page 5\/5 · 1 box\b/i)).toBeVisible()

  const outPath = await runRedact(page)
  const raw = await fs.readFile(outPath)
  for (const n of [1, 2, 3, 4, 5]) expect(raw.includes(`PAGE${n}SECRET`)).toBe(false)

  const pages = await renderPages(page, outPath)
  expect(pages).toHaveLength(5)
  for (const [i, p] of pages.entries()) {
    const centre = await region(page, p.src, 0.2, 0.44, 0.8, 0.56)
    if ([1, 3, 5].includes(i + 1)) {
      expect(centre.max, `page ${i + 1} should be fully redacted at its centre`).toBeLessThan(20)
    } else {
      // Untouched page: its own text is still there as pixels, on white.
      expect(centre.min, `page ${i + 1} should still show its text`).toBeLessThan(160)
      expect(centre.max, `page ${i + 1} should not be blacked out`).toBeGreaterThan(200)
    }
  }
})

test('a mixed-page-size document goes through the per-page + merge fallback intact', async ({ page }) => {
  test.setTimeout(180_000)
  // adv-mixed.pdf is Letter (612×792pt) followed by A5 (420×595pt). Unequal
  // physical sizes are the ONLY trigger for tool.tsx's non-uniform branch:
  // one imagesToPDF call per page followed by engine.merge. Before this test
  // that branch had zero coverage (docs/tools/redact.md said so explicitly).
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-mixed.pdf'))
  await expect(page.getByText(/2 pages/i)).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  await dragBox(page, 0.02, 0.86, 0.6, 0.99)
  await page.getByRole('button', { name: /^next$/i }).click()
  await expect(page.locator('canvas')).toBeVisible()
  await dragBox(page, 0.02, 0.86, 0.6, 0.99)

  const outPath = await runRedact(page)
  const raw = await fs.readFile(outPath)
  expect(raw.includes('MIXAA11')).toBe(false)
  expect(raw.includes('MIXBB22')).toBe(false)

  const pages = await renderPages(page, outPath)
  expect(pages).toHaveLength(2)
  // Each page kept its OWN physical size through the merge — an A5 page
  // silently promoted to Letter (or vice versa) would show up here.
  const ratio = (p: { w: number; h: number }) => p.w / p.h
  expect(ratio(pages[0])).toBeCloseTo(612 / 792, 2)
  expect(ratio(pages[1])).toBeCloseTo(420 / 595, 2)
  for (const [i, p] of pages.entries()) {
    const covered = await region(page, p.src, 0.05, 0.88, 0.55, 0.97)
    expect(covered.max, `page ${i + 1} redacted strip`).toBeLessThan(20)
    const spared = await region(page, p.src, 0.2, 0.2, 0.8, 0.6)
    expect(spared.min, `page ${i + 1} untouched area`).toBeGreaterThan(200)
  }
})

// ------------------------------------------------------- encrypted source

test('a password-protected source is unlocked, really rendered, and really redacted', async ({ page }) => {
  test.setTimeout(180_000)
  // The failure mode this guards is not "the secret leaks" — it's the
  // quieter one: a decode that fails softly and rasterizes a blank page, so
  // the output LOOKS redacted while never having contained the real content.
  // Hence the assertion that the untouched corner still carries real glyph
  // pixels, not just that the boxed corner is black.
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-encrypted.pdf'))

  const pw = page.locator('input[type="password"]')
  await expect(pw).toBeVisible({ timeout: 30_000 })
  await pw.fill('hunter2')
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/1 page/i)).toBeVisible()

  await dragBox(page, 0.02, 0.86, 0.6, 0.99)
  const outPath = await runRedact(page)

  const raw = await fs.readFile(outPath)
  expect(raw.includes('ENC77CC')).toBe(false)
  expect(raw.includes('ENC88DD')).toBe(false)

  const pages = await renderPages(page, outPath)
  const covered = await region(page, pages[0].src, 0.05, 0.88, 0.55, 0.97)
  expect(covered.max).toBeLessThan(20)
  // Real content was decoded, not a blank: the top-right stamp is present.
  const spared = await region(page, pages[0].src, 0.5, 0.01, 0.99, 0.09)
  expect(spared.min).toBeLessThan(160)
  expect(spared.max).toBeGreaterThan(200)
})

test('a wrong password is reported as such, not as a dead-end error', async ({ page }) => {
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-encrypted.pdf'))
  const pw = page.locator('input[type="password"]')
  await expect(pw).toBeVisible({ timeout: 30_000 })
  await pw.fill('not-the-password')
  await page.getByRole('button', { name: /^unlock$/i }).click()
  await expect(page.getByText(/password is incorrect/i)).toBeVisible({ timeout: 30_000 })
  // Still recoverable — the prompt has to survive a wrong attempt.
  await expect(pw).toBeVisible()
})

// ----------------------------------------------------------- state machine

test('the box editor is frozen while a redaction run is in flight', async ({ page }) => {
  test.setTimeout(240_000)
  // The dangerous version of this bug is silent: apply() closes over the
  // boxes as they were when Redact was clicked, but nothing used to stop the
  // user drawing more while it ran. The new box appeared in the count and on
  // the canvas, the run finished, the UI said "Redacted" — and the shipped
  // file did not contain that box. A redaction tool must never report success
  // for a set of boxes that isn't the set the user is looking at.
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-multi5.pdf'))
  await expect(page.locator('canvas')).toBeVisible()
  await dragBox(page, 0.15, 0.4, 0.85, 0.6)
  await expect(page.getByText(/1 box\b/i)).toBeVisible()

  await page.getByRole('button', { name: /^redact$/i }).click()
  await expect(page.getByText(/Rendering \d+\/5/)).toBeVisible({ timeout: 30_000 })

  await expect(page.getByRole('button', { name: /^redact entire page$/i })).toBeDisabled()
  await expect(page.getByRole('button', { name: /^clear all$/i })).toBeDisabled()
  // A drag on the canvas mid-run must not add a box that will never ship.
  await dragBox(page, 0.1, 0.1, 0.4, 0.3)
  await expect(page.getByText(/1 box\b/i)).toBeVisible()

  await expect(page.getByText(/^redacted ·/i)).toBeVisible({ timeout: 180_000 })
  await expect(page.getByText(/1 box\b/i)).toBeVisible()
})

test('cancelling a run never leaves a downloadable result', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/#/redact-pdf')
  await page.locator('input[type="file"]').setInputFiles(fx('adv-multi5.pdf'))
  await expect(page.locator('canvas')).toBeVisible()
  await dragBox(page, 0.15, 0.4, 0.85, 0.6)

  await page.getByRole('button', { name: /^redact$/i }).click()
  await expect(page.getByText(/Rendering \d+\/5/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /^cancel$/i }).click()

  await expect(page.getByText(/cancelled/i)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /^download$/i })).toHaveCount(0)
  await expect(page.getByText(/^redacted ·/i)).toHaveCount(0)
})
