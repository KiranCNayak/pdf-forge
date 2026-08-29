import { expect, test } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Two independent browser contexts stand in for two devices, both against the
// same real signaling server (playwright.config.ts's second webServer entry —
// see web/.env.example for why VITE_SIGNALING_URL needs no override here).
// WebRTC's own handshake (offer/answer/ICE) runs for real between them.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(__dirname, '..', 'public', 'fixtures', name)
const ROOM_CODE = /^[0-9A-Z]{6}$/

test('sends a file from one browser context to another, unencrypted', async ({ browser }) => {
  const senderCtx = await browser.newContext()
  const receiverCtx = await browser.newContext()
  const sender = await senderCtx.newPage()
  const receiver = await receiverCtx.newPage()

  try {
    await sender.goto('/#/p2p-share')
    await sender.getByRole('button', { name: /^send a file$/i }).click()
    await sender.locator('input[type="file"]').setInputFiles(fixture('sample-a.pdf'))
    await sender.getByRole('button', { name: /^create room$/i }).click()

    const codeLocator = sender.locator('p').filter({ hasText: ROOM_CODE })
    await expect(codeLocator).toBeVisible({ timeout: 15_000 })
    const code = (await codeLocator.textContent())!.trim()
    expect(code).toMatch(ROOM_CODE)

    await receiver.goto('/#/p2p-share')
    await receiver.getByRole('button', { name: /^receive a file$/i }).click()
    await receiver.getByLabel(/room code/i).fill(code)
    await receiver.getByRole('button', { name: /^connect$/i }).click()

    await expect(receiver.getByText(/^incoming: sample-a\.pdf/i)).toBeVisible({ timeout: 15_000 })
    await receiver.getByRole('button', { name: /^accept$/i }).click()

    await expect(sender.getByText(/^sent ·/i)).toBeVisible({ timeout: 15_000 })
    await expect(receiver.getByText(/integrity verified/i)).toBeVisible({ timeout: 15_000 })

    const [download] = await Promise.all([
      receiver.waitForEvent('download'),
      receiver.getByRole('button', { name: /^download$/i }).click(),
    ])
    expect(download.suggestedFilename()).toBe('sample-a.pdf')
  } finally {
    await senderCtx.close()
    await receiverCtx.close()
  }
})

test('a wrong password is reported distinctly on an encrypted transfer', async ({ browser }) => {
  const senderCtx = await browser.newContext()
  const receiverCtx = await browser.newContext()
  const sender = await senderCtx.newPage()
  const receiver = await receiverCtx.newPage()

  try {
    await sender.goto('/#/p2p-share')
    await sender.getByRole('button', { name: /^send a file$/i }).click()
    await sender.locator('input[type="file"]').setInputFiles(fixture('sample-b.pdf'))
    await sender.getByLabel(/password \(optional\)/i).fill('correct horse battery staple')
    await sender.getByRole('button', { name: /^create room$/i }).click()

    const codeLocator = sender.locator('p').filter({ hasText: ROOM_CODE })
    await expect(codeLocator).toBeVisible({ timeout: 15_000 })
    const code = (await codeLocator.textContent())!.trim()

    await receiver.goto('/#/p2p-share')
    await receiver.getByRole('button', { name: /^receive a file$/i }).click()
    await receiver.getByLabel(/room code/i).fill(code)
    await receiver.getByRole('button', { name: /^connect$/i }).click()

    await expect(receiver.getByText(/^incoming: sample-b\.pdf/i)).toBeVisible({ timeout: 15_000 })
    const acceptButton = receiver.getByRole('button', { name: /^accept$/i })
    await expect(acceptButton).toBeDisabled() // encrypted offer requires a password first

    await receiver.getByPlaceholder('Password').fill('the wrong password')
    await acceptButton.click()

    await expect(receiver.getByText(/^wrong password\.?$/i)).toBeVisible({ timeout: 15_000 })
  } finally {
    await senderCtx.close()
    await receiverCtx.close()
  }
})
