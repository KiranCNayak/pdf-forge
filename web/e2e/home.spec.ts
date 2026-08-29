import { expect, test } from '@playwright/test'

test('home page lists tools and navigation reaches each one', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Pick a tool' })).toBeVisible()

  const cards = page.locator('.cards li a')
  const count = await cards.count()
  expect(count).toBeGreaterThan(5)

  await page.getByRole('link', { name: /merge pdfs/i }).first().click()
  await expect(page).toHaveURL(/#\/merge$/)
  await expect(page.locator('input[type="file"]')).toBeVisible()
})

test('every tool route renders without a console error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/')
  const hrefs = await page.locator('.cards li a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).hash))

  for (const hash of hrefs) {
    await page.goto(`/${hash}`)
    // Every tool renders a heading (its name) — good enough to prove the
    // route resolved and the lazy chunk loaded, without assuming a shape
    // every tool shares (P2P Share has no FilePicker, for instance).
    await expect(page.locator('h2')).toBeVisible()
  }

  expect(errors).toEqual([])
})
