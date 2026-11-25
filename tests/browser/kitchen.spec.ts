import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createApplication } from '../../backend/src/app.ts'
import { openDatabase } from '../../backend/src/database.ts'
import { seedDemo } from '../../backend/src/seed.ts'

const password = 'kds-browser-fixture'
test.describe.configure({ timeout: 60_000 })
let origin: string
let menuUrl: string
let shutdown: () => Promise<void>
let app: ReturnType<typeof createApplication>

test.beforeEach(async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  app = createApplication(db, resolve('frontend/dist'), password)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  origin = 'http://127.0.0.1:' + address.port
  const table = db.prepare("SELECT public_code FROM restaurant_tables WHERE number='04'").get()
  menuUrl = origin + '/menu/' + table?.public_code
  shutdown = async () => { await app.io.close(); db.close() }
})
test.afterEach(async ({ page }) => { await page.close(); await shutdown() })

async function staff(page: Page, path: 'cashier' | 'kitchen') {
  await page.goto(origin + '/' + path)
  await page.getByLabel('Staff password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible()
}
async function submit(page: Page, note: string) {
  await page.getByRole('button', { name: 'Add Classic Zinger' }).click()
  await page.getByLabel('Special instructions').fill(note)
  await page.getByRole('button', { name: /Add to cart/ }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  await page.getByRole('button', { name: 'Send order', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  return page.locator('.order-reference strong').first().innerText()
}
async function approve(cashier: Page, reference: string, verify: boolean) {
  await cashier.getByRole('region', { name: 'Incoming orders' }).getByRole('button', { name: new RegExp(reference) }).click()
  if (verify) await cashier.getByRole('checkbox').check()
  await cashier.getByRole('button', { name: 'Approve order' }).click()
}
const ticket = (page: Page, ref: string) => page.getByRole('article', { name: 'Ticket ' + ref })
async function capture(page: Page, name: string) {
  const folder = resolve('test-results/screenshots')
  await mkdir(folder, { recursive: true })
  await page.screenshot({ path: resolve(folder, name + '.png'), fullPage: true })
}

test('Table 04 progresses on two kitchen displays and remains consistent with customer, cashier and billing', async ({ page: kitchen, browser }, info) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext({ viewport: kitchen.viewportSize()! })])
  const [customer, cashier, second] = await Promise.all(contexts.map(context => context.newPage()))
  try {
    await kitchen.addInitScript(() => {
      const start = OscillatorNode.prototype.start
      const soundStarts: number[] = []
      Object.assign(window, { kitchenSoundStarts: soundStarts })
      OscillatorNode.prototype.start = function (...args) {
        soundStarts.push(Date.now())
        return start.apply(this, args)
      }
    })
    const chimes = () => kitchen.evaluate(() => (window as Window & { kitchenSoundStarts: number[] }).kitchenSoundStarts.length)
    await Promise.all([staff(kitchen, 'kitchen'), staff(second, 'kitchen'), staff(cashier, 'cashier')])
    await kitchen.getByRole('button', { name: 'Enable sound' }).click()
    await expect(kitchen.getByRole('button', { name: 'Mute sound' })).toBeVisible()
    await customer.goto(menuUrl)
    const first = await submit(customer, 'No lettuce')
    await expect(cashier.getByText(first, { exact: true })).toBeVisible()
    await expect(ticket(kitchen, first)).toHaveCount(0)
    expect(await chimes()).toBe(0)
    await approve(cashier, first, true)
    await expect(ticket(kitchen, first)).toBeVisible()
    await expect(ticket(second, first)).toBeVisible()
    await expect.poll(chimes).toBe(1)
    await expect(ticket(kitchen, first).getByText('No lettuce')).toBeVisible()
    await expect(ticket(kitchen, first).getByText(/PKR/)).toHaveCount(0)
    const width = await kitchen.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    expect(width).toBe(true)
    await capture(kitchen, 'phase4-kitchen-new-' + info.project.name)

    const approvedAt = await ticket(kitchen, first).locator('time').getAttribute('datetime')
    await ticket(kitchen, first).getByRole('button', { name: 'Start preparing' }).click()
    await expect(customer.getByRole('heading', { name: 'Your order is being prepared' })).toBeVisible()
    await cashier.getByRole('region', { name: 'Active table sessions' }).getByRole('button', { name: /Table 04/ }).click()
    const sitting = cashier.getByRole('region', { name: 'Selected table session' })
    await expect(sitting.getByText(new RegExp(first + ' · Preparing'))).toBeVisible()
    await expect(ticket(second, first).getByRole('button', { name: 'Mark ready' })).toBeVisible()
    await kitchen.reload()
    await expect(ticket(kitchen, first).locator('time')).toHaveAttribute('datetime', approvedAt!)
    await kitchen.getByRole('button', { name: 'Enable sound' }).click()
    expect(await chimes()).toBe(0)
    await capture(kitchen, 'phase4-kitchen-preparing-' + info.project.name)
    await capture(cashier, 'phase4-cashier-' + info.project.name)

    await kitchen.context().setOffline(true)
    for (const socket of app.io.sockets.sockets.values()) socket.conn.close()
    await expect(kitchen.getByText('Reconnecting', { exact: true })).toBeVisible()
    await ticket(second, first).getByRole('button', { name: 'Mark ready' }).click()
    await expect(customer.getByRole('heading', { name: 'Your order is ready' })).toBeVisible()
    await expect(sitting.getByText(new RegExp(first + ' · Ready'))).toBeVisible()
    await kitchen.context().setOffline(false)
    await expect(kitchen.getByText('Live updates', { exact: true })).toBeVisible()
    await expect(ticket(kitchen, first).getByRole('button', { name: 'Mark served' })).toBeVisible()
    await expect(kitchen.getByRole('alert')).toHaveCount(0)
    expect(await chimes()).toBe(0)
    await capture(kitchen, 'phase4-kitchen-ready-' + info.project.name)
    await capture(customer, 'phase4-customer-ready-' + info.project.name)

    await ticket(kitchen, first).getByRole('button', { name: 'Mark served' }).click()
    await expect(ticket(second, first)).toHaveCount(0)
    await expect(ticket(kitchen, first)).toHaveCount(0)
    await expect(customer.getByRole('heading', { name: 'Order served' })).toBeVisible()
    await expect(sitting.getByText(new RegExp(first + ' · Served'))).toBeVisible()
    expect(await chimes()).toBe(0)
    await customer.getByRole('button', { name: 'Continue ordering' }).click()
    const next = await submit(customer, 'Extra napkins')
    await expect(ticket(kitchen, next)).toHaveCount(0)
    await approve(cashier, next, false)
    await expect(ticket(kitchen, next).getByText('Additional order')).toBeVisible()
    await expect(ticket(kitchen, next).getByText('Extra napkins')).toBeVisible()
    await expect(ticket(kitchen, first)).toHaveCount(0)
    await expect.poll(chimes).toBe(1)
    await ticket(kitchen, next).getByRole('button', { name: 'Start preparing' }).click()
    await ticket(kitchen, next).getByRole('button', { name: 'Mark ready' }).click()
    await ticket(kitchen, next).getByRole('button', { name: 'Mark served' }).click()

    await customer.getByRole('button', { name: 'Request bill' }).click()
    await cashier.getByRole('button', { name: 'Settle bill' }).click()
    const settlement = cashier.getByRole('dialog')
    await expect(settlement.getByText(/PKR\s*1,100/)).toBeVisible()
    await expect(settlement.getByText(/unfinished kitchen orders/)).toHaveCount(0)
    await settlement.getByRole('button', { name: 'Confirm settlement' }).click()
    await expect(customer.getByRole('heading', { name: 'Session closed' })).toBeVisible()
    await expect(customer.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await kitchen.getByRole('button', { name: 'Sign out' }).click()
    await expect(kitchen.getByLabel('Staff password')).toBeVisible()
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})

test('settling early warns the cashier and leaves the old ticket separate from the next sitting', async ({ page: kitchen, browser }, info) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const [customer, cashier, visitor] = await Promise.all(contexts.map(context => context.newPage()))
  try {
    await Promise.all([staff(kitchen, 'kitchen'), staff(cashier, 'cashier')])
    await customer.goto(menuUrl)
    const earlier = await submit(customer, 'Old sitting')
    await approve(cashier, earlier, true)
    await ticket(kitchen, earlier).getByRole('button', { name: 'Start preparing' }).click()
    await customer.getByRole('button', { name: 'Request bill' }).click()
    await cashier.getByRole('region', { name: 'Bill requests' }).getByRole('button', { name: /Table 04/ }).click()
    await cashier.getByRole('button', { name: 'Settle bill' }).click()
    const dialog = cashier.getByRole('dialog')
    await expect(dialog.getByText(/unfinished kitchen orders/)).toBeVisible()
    await capture(cashier, 'phase4-settlement-warning-' + info.project.name)
    await dialog.getByRole('button', { name: 'Confirm settlement' }).click()
    await expect(customer.getByRole('heading', { name: 'Session closed' })).toBeVisible()
    await expect(ticket(kitchen, earlier).getByText('Sitting closed')).toBeVisible()

    await visitor.goto(menuUrl)
    const fresh = await submit(visitor, 'New sitting')
    await approve(cashier, fresh, true)
    await expect(ticket(kitchen, fresh).getByText('New sitting', { exact: true })).toBeVisible()
    await expect(ticket(kitchen, fresh).getByText('Sitting closed')).toHaveCount(0)
    await expect(ticket(kitchen, earlier).getByRole('button', { name: 'Mark ready' })).toBeVisible()
    await capture(kitchen, 'phase4-kitchen-closed-' + info.project.name)
    await ticket(kitchen, earlier).getByRole('button', { name: 'Mark ready' }).click()
    await expect(customer.locator('.receipt').getByText('Ready', { exact: true })).toBeVisible()
    await expect(visitor.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await ticket(kitchen, earlier).getByRole('button', { name: 'Mark served' }).click()
    await expect(ticket(kitchen, earlier)).toHaveCount(0)
    await expect(ticket(kitchen, fresh)).toBeVisible()
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
