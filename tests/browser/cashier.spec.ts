import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createApplication } from '../../backend/src/app.ts'
import { openDatabase } from '../../backend/src/database.ts'
import { seedDemo } from '../../backend/src/seed.ts'

const password = 'fixture-cashier-browser'
test.describe.configure({ timeout: 60_000 })
let origin: string
let customerUrl: string
let shutdown: () => Promise<void>
let app: ReturnType<typeof createApplication>

test.beforeEach(async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  app = createApplication(db, resolve('frontend/dist'), password)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Test server failed to start')
  origin = 'http://127.0.0.1:' + address.port
  const code = db.prepare("SELECT public_code FROM restaurant_tables WHERE number = '04'").get()?.public_code
  customerUrl = origin + '/menu/' + code
  shutdown = async () => { await app.io.close(); db.close() }
})

test.afterEach(async ({ page }) => {
  await page.close()
  await shutdown?.()
})

async function login(page: Page) {
  await page.goto(origin + '/cashier')
  await page.getByLabel('Staff password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible()
}

async function menu(page: Page) {
  await page.goto(customerUrl)
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible()
}

async function send(page: Page) {
  await page.getByRole('button', { name: 'Add Classic Zinger' }).click()
  await page.getByLabel('Special instructions').fill('No lettuce')
  await page.getByRole('button', { name: /Add to cart/ }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  const submit = page.getByRole('button', { name: 'Send order', exact: true })
  await submit.evaluate(button => {
    const element = button as HTMLButtonElement
    element.click()
    element.click()
  })
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  return page.locator('.order-reference strong').innerText()
}

function choose(page: Page, reference: string) {
  return page.getByRole('region', { name: 'Incoming orders' }).getByRole('button', { name: new RegExp(reference) }).click()
}

async function approve(page: Page, physicalVerification: boolean) {
  if (physicalVerification) await page.getByRole('checkbox', { name: /I verified in person/ }).check()
  await page.getByRole('button', { name: 'Approve order' }).click()
  await expect(page.getByText('Order approved.', { exact: true })).toBeVisible()
}

async function screenshot(page: Page, name: string) {
  const folder = resolve('test-results/screenshots')
  await mkdir(folder, { recursive: true })
  await page.screenshot({ path: resolve(folder, name + '.png'), fullPage: true })
}

test('cashier settles Table 04 and the next sitting is isolated across browser contexts', async ({ page: cashier, browser }, info) => {
  const contextA = await browser.newContext({ viewport: cashier.viewportSize() ?? undefined })
  const contextB = await browser.newContext({ viewport: cashier.viewportSize() ?? undefined })
  const a = await contextA.newPage()
  const b = await contextB.newPage()
  try {
    await login(cashier)
    await menu(a)
    const first = await send(a)
    await choose(cashier, first)
    await expect(cashier.getByRole('region', { name: 'Order details' }).getByText('No lettuce')).toBeVisible()
    await expect(cashier.getByRole('button', { name: 'Approve order' })).toBeDisabled()
    await screenshot(cashier, 'cashier-queue-' + info.project.name)
    await approve(cashier, true)
    await expect(a.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await a.reload()
    await expect(a.getByRole('heading', { name: 'Your table order' })).toBeVisible()
    await a.getByText('Confirmed orders (1)', { exact: true }).click()
    await screenshot(a, 'customer-confirmed-' + info.project.name)

    await a.getByRole('button', { name: 'Continue ordering' }).click()
    const additional = await send(a)
    await choose(cashier, additional)
    await expect(cashier.getByRole('region', { name: 'Order details' }).getByText('Authorized browser', { exact: true })).toBeVisible()
    await expect(cashier.getByRole('checkbox')).toHaveCount(0)

    await menu(b)
    await expect(b.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    const outsider = await send(b)
    await expect(b.getByText(first, { exact: true })).toHaveCount(0)
    await choose(cashier, outsider)
    await expect(cashier.getByRole('region', { name: 'Order details' }).getByText('Unknown browser', { exact: true })).toBeVisible()
    await cashier.getByRole('button', { name: 'Reject order' }).click()
    await expect(b.getByRole('heading', { name: 'Order declined' })).toBeVisible()

    await a.getByRole('button', { name: 'Request bill' }).click()
    await expect(a.getByText('Bill requested. Ordering is paused.')).toBeVisible()
    const session = cashier.getByRole('region', { name: 'Selected table session' })
    await cashier.getByRole('region', { name: 'Bill requests' }).getByRole('button', { name: /Table 04/ }).click()
    await expect(session.getByRole('button', { name: 'Settle bill' })).toBeDisabled()
    await choose(cashier, additional)
    await approve(cashier, false)
    await expect(a.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await expect(session.getByRole('button', { name: 'Settle bill' })).toBeEnabled()
    await screenshot(cashier, 'cashier-bill-' + info.project.name)
    await cashier.getByRole('button', { name: 'Settle bill' }).click()
    const confirmation = cashier.getByRole('dialog', { name: 'Settle Table 04?' })
    await expect(confirmation.getByText(/PKR\s*1,100/)).toBeVisible()
    await confirmation.getByRole('button', { name: 'Confirm settlement' }).click()
    await expect(a.getByRole('heading', { name: 'Session closed' })).toBeVisible()
    await expect(a.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await screenshot(a, 'customer-closed-' + info.project.name)

    await b.getByRole('button', { name: 'Back to menu' }).click()
    const next = await send(b)
    await choose(cashier, next)
    await approve(cashier, true)
    await expect(b.getByRole('heading', { name: 'Your table order' })).toBeVisible()
    await a.reload()
    await expect(a.getByRole('heading', { name: 'Session closed' })).toBeVisible()
    await expect(a.getByText(next, { exact: true })).toHaveCount(0)
    await expect(a.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('cashier reconnects, reviews a stale request and explicitly admits an unknown browser', async ({ page: cashier, browser }, info) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const otherStaff = await browser.newContext()
  try {
    const a = await contextA.newPage()
    const b = await contextB.newPage()
    const secondCashier = await otherStaff.newPage()
    await login(cashier)
    await menu(a)
    await menu(b)
    const first = await send(a)
    const candidate = await send(b)
    await choose(cashier, candidate)
    await cashier.getByRole('checkbox').check()

    await login(secondCashier)
    await choose(secondCashier, first)
    await approve(secondCashier, true)
    await expect(cashier.getByRole('button', { name: 'Review updated request' })).toBeVisible()
    await expect(cashier.getByRole('button', { name: 'Approve order' })).toBeDisabled()
    await expect(b.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await cashier.getByRole('button', { name: 'Review updated request' }).click()
    await expect(cashier.getByRole('checkbox')).not.toBeChecked()
    await expect(cashier.getByRole('region', { name: 'Order details' }).getByText('Unknown browser', { exact: true })).toBeVisible()
    await screenshot(cashier, 'cashier-verification-' + info.project.name)
    await approve(cashier, true)
    await expect(b.getByText('Confirmed orders (2)', { exact: true })).toBeVisible()

    const staffSockets = await app.io.in('staff:order-requests').fetchSockets()
    expect(staffSockets.length).toBe(2)
    await cashier.context().setOffline(true)
    for (const socket of app.io.sockets.sockets.values()) socket.conn.close()
    await expect(cashier.getByText('Reconnecting', { exact: true })).toBeVisible()
    await a.getByRole('button', { name: 'Continue ordering' }).click()
    const request = await send(a)
    await cashier.context().setOffline(false)
    await expect(cashier.getByText('Live updates', { exact: true })).toBeVisible()
    await choose(cashier, request)
    await expect(cashier.getByRole('region', { name: 'Order details' }).getByText('Authorized browser', { exact: true })).toBeVisible()
    await cashier.getByRole('region', { name: 'Active table sessions' }).getByRole('button', { name: /Table 04/ }).click()
    await cashier.getByRole('button', { name: 'Revoke access' }).first().click()
    await expect(a.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await expect(cashier.getByRole('button', { name: 'Review updated request' })).toBeVisible()
    await cashier.getByRole('button', { name: 'Sign out' }).click()
    await expect(cashier.getByLabel('Staff password')).toBeVisible()
  } finally {
    await contextA.close()
    await contextB.close()
    await otherStaff.close()
  }
})
