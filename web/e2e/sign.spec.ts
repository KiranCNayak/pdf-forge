import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// sample-a.pdf is 3 pages of solid colour (red, green, blue — see
// engine/cmd/genfixtures), no dark content anywhere. That makes it a good
// fixture for this test: a page's own base colour averages ~85-115
// brightness (never close to black), so "is there real ink here" is a wide,
// unambiguous margin either way — no need to distinguish similar shades.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)

async function dragStroke(page: import('@playwright/test').Page, x0: number, y0: number, x1: number, y1: number) {
  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas not visible')
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 6 })
  await page.mouse.up()
}

test('sign button is disabled until a signature is drawn, and selection defaults to the last page', async ({
  page,
}) => {
  await page.goto('/#/sign-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  const signButton = page.getByRole('button', { name: /^sign$/i })
  await expect(signButton).toBeDisabled()

  // Last page (3) pre-filled, not "all pages".
  const selectionInput = page.getByPlaceholder('1-3, 5')
  await expect(selectionInput).toHaveValue('3')

  await dragStroke(page, 0.1, 0.3, 0.6, 0.7)
  await expect(signButton).toBeEnabled()

  await page.getByRole('button', { name: /^clear$/i }).click()
  await expect(signButton).toBeDisabled()
})

test('stamps a signature onto only the selected page, nowhere else', async ({ page }) => {
  await page.goto('/#/sign-pdf')
  await page.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
  await expect(page.getByText(/3 pages/i)).toBeVisible()

  // sample-a.pdf's pages are a deliberately tiny 120x160pt fixture (see
  // engine/cmd/genfixtures) — at the tool's own default 25% placement size
  // that's a ~30pt-wide stamp, and a hairline stroke drawn on the (much
  // higher-resolution) signature canvas becomes sub-pixel once scaled down
  // that far, invisible at any reasonable render DPI regardless of whether
  // the stamp is really there. A real document page is 5x+ wider, where the
  // tool's own default is in no danger of this — bumping size here is a
  // fixture-scale compensation, not evidence the default is wrong.
  await page.getByLabel(/size \(% of page width\)/i).fill('80')
  await dragStroke(page, 0.1, 0.3, 0.7, 0.7)

  const signButton = page.getByRole('button', { name: /^sign$/i })
  await expect(signButton).toBeEnabled()
  await signButton.click()

  await expect(page.getByText(/^signed ·/i)).toBeVisible({ timeout: 15_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^download$/i }).click(),
  ])
  const outPath = await download.path()
  expect(outPath).toBeTruthy()

  // Independent verification: render the output back through PdfToImage and
  // sample the default "br" placement region on both the signed page (3)
  // and an untouched page (1).
  await page.goto('/#/pdf-to-jpg')
  const fileInput = page.locator('input[type="file"]')
  await expect(fileInput).toBeVisible()
  await fileInput.setInputFiles(outPath!)
  await page.getByRole('radio', { name: /^png$/i }).check()
  await page.getByRole('button', { name: /^convert$/i }).click()
  await expect(page.getByAltText('Page 3')).toBeVisible({ timeout: 30_000 })

  const minBrightness = async (alt: string, x0: number, y0: number, x1: number, y1: number) => {
    const src = await page.getByAltText(alt).getAttribute('src')
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
        for (let k = 0; k < d.length; k += 4) min = Math.min(min, (d[k] + d[k + 1] + d[k + 2]) / 3)
        return min
      },
      { s: src!, r: [x0, y0, x1, y1] },
    )
  }

  // Whole page, not a precise sub-region — the exact placement footprint of
  // a 25%-scale image at a named anchor isn't worth hand-computing here; the
  // property that matters is "some real ink landed on the signed page and
  // none did on an untouched one," not exactly where.
  const signedPage = await minBrightness('Page 3', 0, 0, 1, 1)
  const untouchedPage = await minBrightness('Page 1', 0, 0, 1, 1)

  expect(signedPage).toBeLessThan(50) // real dark ink present somewhere
  expect(untouchedPage).toBeGreaterThan(70) // still just the page's own solid colour, no stray ink
})
