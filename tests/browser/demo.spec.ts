import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createApplication } from '../../backend/src/app.ts'
import { openDatabase } from '../../backend/src/database.ts'
import { seedDemo } from '../../backend/src/seed.ts'

const password = 'isolated-demo-audit-fixture'
const literal = '<em>Serve separately</em>'
test.describe.configure({ timeout: 110_000 })

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'urban-demo-browser-'))
  const path = join(folder, 'fixture.sqlite')
  let db = openDatabase(path)
  seedDemo(db)
  let port = 0
  let app: ReturnType<typeof createApplication>

  async function start() {
    app = createApplication(db, resolve('frontend/dist'), password)
    app.server.listen(port, '127.0.0.1')
    await once(app.server, 'listening')
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server not available')
    port = address.port
  }

  async function stop() {
    const closed = app.io.close()
    app.server.closeAllConnections()
    await closed
    db.close()
  }
  await start()
  const origin = 'http://127.0.0.1:' + port
  const code = String(db.prepare("SELECT public_code FROM restaurant_tables WHERE number='04'").get()?.public_code)
  const data = () => {
    const table = db.prepare("SELECT id FROM restaurant_tables WHERE number='04'").get()
    return {
      orders: db.prepare('SELECT * FROM orders WHERE table_id=? ORDER BY id').all(Number(table?.id)),
      sessions: db.prepare('SELECT * FROM table_sessions WHERE table_id=? ORDER BY id').all(Number(table?.id)),
      grants: db.prepare('SELECT * FROM browser_authorizations ORDER BY id').all(),
      items: db.prepare('SELECT * FROM order_items ORDER BY id').all(),
    }
  }
  return {
    origin, code, orders: origin + '/api/tables/' + code + '/orders', data,
    async restart() { await stop(); db = openDatabase(path); await start() },
    async close() { await stop(); await rm(folder, { recursive: true, force: true }) },
  }
}

async function login(page: Page, origin: string, route: string) {
  await page.goto(origin + '/' + route)
  await page.getByLabel('Staff password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible()
}

async function add(page: Page, name: string, quantity: number, instructions = '') {
  await page.getByRole('button', { name: 'Add ' + name, exact: true }).click()
  const dialog = page.getByRole('dialog')
  if (instructions) await dialog.getByLabel('Special instructions').fill(instructions)
  for (let index = 1; index < quantity; index++) {
    await dialog.getByRole('button', { name: 'Increase ' + name + ' quantity' }).click()
  }
  await dialog.getByRole('button', { name: /Add to cart/ }).click()
}

async function send(page: Page) {
  await page.getByRole('button', { name: /View cart/ }).click()
  await page.getByRole('button', { name: 'Send order', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  return page.locator('.order-reference strong').first().innerText()
}

const queue = (page: Page) => page.getByRole('region', { name: 'Incoming orders' })
const ticket = (page: Page, ref: string) => page.getByRole('article', { name: 'Ticket ' + ref })
const table = (page: Page) => page.getByRole('region', { name: 'Restaurant tables' }).getByRole('button', { name: /^Table 04/ })
const select = (page: Page, ref: string) => queue(page).getByRole('button', { name: new RegExp(ref) }).click()
async function approve(page: Page, ref: string, verify: boolean) {
  await select(page, ref)
  if (verify) await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Approve order' }).click()
  await expect(page.getByText('Order approved.', { exact: true })).toBeVisible()
}

async function capture(page: Page, name: string) {
  const directory = resolve('test-results/screenshots')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: resolve(directory, name + '.png'), fullPage: true })
}

test('complete Table 04 demonstration across independent clients, including restart and next-sitting isolation', async ({ page: tables, browser }, info) => {
  const f = await fixture()
  const viewport = tables.viewportSize()!
  const [aContext, bContext, cContext, cashierContext, kitchenContext] = await Promise.all([
    browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }),
    browser.newContext(), browser.newContext(), browser.newContext({ viewport }), browser.newContext({ viewport }),
  ])
  try {
    const [a, b, c, cashier, kitchen] = await Promise.all([aContext, bContext, cContext, cashierContext, kitchenContext].map(context => context.newPage()))
    await Promise.all([login(tables, f.origin, 'tables'), login(cashier, f.origin, 'cashier'), login(kitchen, f.origin, 'kitchen')])
    await expect(table(tables)).toContainText('Available')
    await tables.getByLabel('QR base URL').fill(f.origin)
    await tables.getByRole('button', { name: 'Apply address' }).click()
    await table(tables).click()
    const link = tables.getByRole('link', { name: 'Open customer menu' })
    await expect(link).toHaveAttribute('href', f.origin + '/menu/' + f.code)
    const savedUrl = (await link.getAttribute('href'))!
    await a.goto(savedUrl)
    await expect(a.getByRole('heading', { name: 'Our menu' })).toBeVisible()
    expect(f.data().sessions).toHaveLength(0)
    expect(f.data().grants).toHaveLength(0)
    await add(a, 'Classic Zinger', 2, literal)
    await a.getByRole('navigation', { name: 'Menu categories' }).getByRole('link', { name: 'Sides' }).click()
    await add(a, 'Regular Fries', 1, 'Light salt')
    const first = await send(a)
    const order = (ref: string) => f.data().orders.find(row => row.public_reference === ref)
    await expect(queue(cashier).getByText(first)).toBeVisible()
    await expect(ticket(kitchen, first)).toHaveCount(0)
    await expect(table(tables)).toContainText('First order awaiting verification')
    expect(order(first)).toMatchObject({ status: 'pending', total_minor: 135000, session_id: null })
    expect(f.data().grants).toHaveLength(0)
    expect(f.data().items.map(row => [row.quantity, row.unit_price_minor])).toEqual([[2, 55000], [1, 25000]])

    await select(cashier, first)
    const orderDetails = cashier.getByRole('region', { name: 'Order details' })
    await expect(orderDetails.getByText(literal, { exact: true })).toBeVisible()
    await expect(orderDetails.locator('em')).toHaveCount(0)
    await expect(cashier.getByRole('button', { name: 'Approve order' })).toBeDisabled()
    await capture(cashier, 'phase6-cashier-' + info.project.name)
    await approve(cashier, first, true)
    await expect(table(tables)).toContainText('Occupied')
    await expect(a.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await expect(ticket(kitchen, first).getByText(literal, { exact: true })).toBeVisible()
    await expect(ticket(kitchen, first).locator('em')).toHaveCount(0)
    expect(order(first)?.status).toBe('approved')
    expect(f.data().sessions).toHaveLength(1)
    expect(f.data().grants).toHaveLength(1)
    await capture(tables, 'phase6-tables-' + info.project.name)
    const oldAccess = (await (await a.request.get(f.orders + '/session')).json()).session.key

    await ticket(kitchen, first).getByRole('button', { name: 'Start preparing' }).click()
    await expect(a.getByRole('heading', { name: 'Your order is being prepared' })).toBeVisible()
    const timestamp = order(first)?.preparation_started_at
    expect(timestamp).toBeTruthy()
    await capture(kitchen, 'phase6-kitchen-' + info.project.name)

    await f.restart()
    await expect(kitchen.getByText('Live updates', { exact: true })).toBeVisible()
    await expect(cashier.getByText('Live updates', { exact: true })).toBeVisible()
    await expect(tables.getByText('Live updates', { exact: true })).toBeVisible()
    await expect(ticket(kitchen, first).getByRole('button', { name: 'Mark ready' })).toBeVisible()
    expect(order(first)?.preparation_started_at).toBe(timestamp)
    await expect(link).toHaveAttribute('href', savedUrl)
    await a.reload()
    await expect(a.getByRole('heading', { name: 'Your order is being prepared' })).toBeVisible()
    await expect(a.getByRole('heading', { name: 'Your order is being prepared' })).toBeFocused()
    await expect(a.getByRole('heading', { name: 'Your order is being prepared' })).toHaveCSS('outline-style', 'none')

    await ticket(kitchen, first).getByRole('button', { name: 'Mark ready' }).click()
    await expect(a.getByRole('heading', { name: 'Your order is ready' })).toBeVisible()
    expect(order(first)?.ready_at).toBeTruthy()
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await capture(a, 'phase6-customer-' + info.project.name)
    await ticket(kitchen, first).getByRole('button', { name: 'Mark served' }).click()
    await expect(ticket(kitchen, first)).toHaveCount(0)
    await expect(a.getByRole('heading', { name: 'Order served' })).toBeVisible()
    expect(order(first)?.served_at).toBeTruthy()

    await a.getByRole('button', { name: 'Continue ordering' }).click()
    await add(a, 'Pepsi', 2)
    const second = await send(a)
    expect(order(second)).toMatchObject({ status: 'pending', session_id: order(first)?.session_id, total_minor: 24000 })
    await expect(ticket(kitchen, second)).toHaveCount(0)
    await approve(cashier, second, false)
    await expect(ticket(kitchen, second).getByText('Additional order')).toBeVisible()
    for (const action of ['Start preparing', 'Mark ready', 'Mark served']) {
      await ticket(kitchen, second).getByRole('button', { name: action }).click()
    }
    await expect(ticket(kitchen, second)).toHaveCount(0)
    await expect(a.getByRole('heading', { name: 'Order served' })).toBeVisible()

    await b.goto(savedUrl)
    await expect(b.getByRole('heading', { name: 'Our menu' })).toBeVisible()
    expect(await (await b.request.get(f.orders + '/session')).json()).toEqual({ session: null })
    expect(await (await b.request.get(f.orders + '/latest')).json()).toEqual({ order: null })
    await expect(b.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await b.route('**/orders', async route => {
      const draft = route.request().postDataJSON()
      await route.continue({ postData: JSON.stringify({ ...draft, sessionId: order(first)?.session_id, authorized: true, totalMinor: 1 }) })
    }, { times: 1 })
    await add(b, 'Pepsi', 1)
    const refused = await send(b)
    expect(order(refused)).toMatchObject({ status: 'pending', session_id: null, total_minor: 12000 })
    await select(cashier, refused)
    await expect(orderDetails.getByText('Unknown browser', { exact: true })).toBeVisible()
    await expect(cashier.getByRole('button', { name: 'Approve order' })).toBeDisabled()
    await cashier.getByRole('button', { name: 'Reject order' }).click()
    await expect(b.getByRole('heading', { name: 'Order declined' })).toBeVisible()
    expect(order(refused)?.status).toBe('rejected')
    expect((await (await a.request.get(f.orders + '/session')).json()).session.confirmedTotalMinor).toBe(159000)

    await a.getByRole('button', { name: 'Request bill' }).click()
    await expect(table(tables)).toContainText('Bill requested')
    const freshOrder = () => ({ idempotencyKey: randomBytes(16).toString('hex'), items: [{ slug: 'pepsi', quantity: 1 }] })
    expect((await b.request.post(f.orders, { data: freshOrder() })).status()).toBe(409)
    await cashier.getByRole('region', { name: 'Bill requests' }).getByRole('button', { name: /Table 04/ }).click()
    await cashier.getByRole('button', { name: 'Settle bill' }).click()
    await expect(cashier.getByRole('dialog').getByText(/PKR\s*1,590/)).toBeVisible()
    await cashier.getByRole('button', { name: 'Confirm settlement' }).click()
    await expect(table(tables)).toContainText('Available')
    await expect(a.getByRole('heading', { name: 'Session closed' })).toBeVisible()
    expect(f.data().sessions[0]).toMatchObject({ settled_total_minor: 159000 })
    expect(f.data().grants.every(grant => grant.revoked_at !== null)).toBe(true)

    await c.goto(savedUrl)
    await add(c, 'Pepsi', 1)
    const next = await send(c)
    await approve(cashier, next, true)
    await expect(c.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await a.goto(savedUrl)
    expect(await (await a.request.get(f.orders + '/session')).json()).toEqual({ session: null })
    expect((await a.request.post(f.orders, { data: { ...freshOrder(), sessionKey: oldAccess } })).status()).toBe(409)
    const remote = await a.request.post(f.orders, { data: freshOrder() })
    expect(remote.status()).toBe(201)
    const remoteRef = (await remote.json()).order.reference
    expect(order(remoteRef)).toMatchObject({ status: 'pending', session_id: null })
    await expect(ticket(kitchen, remoteRef)).toHaveCount(0)
    expect((await (await c.request.get(f.orders + '/session')).json()).session.confirmedTotalMinor).toBe(12000)
    expect((await (await a.request.get(f.orders + '/latest')).json()).order.reference).toBe(remoteRef)
    expect(f.data().sessions.filter(sitting => sitting.closed_at === null)).toHaveLength(1)
  } finally {
    await Promise.all([aContext, bContext, cContext, cashierContext, kitchenContext].map(context => context.close()))
    await tables.goto('about:blank').catch(() => {})
    await f.close()
  }
})

test('live revocation removes a cached bill even while its HTTP refresh is unavailable', async ({ page: cashier, browser }) => {
  const f = await fixture()
  const context = await browser.newContext()
  try {
    const customer = await context.newPage()
    await login(cashier, f.origin, 'cashier')
    await customer.goto(f.origin + '/menu/' + f.code)
    await add(customer, 'Pepsi', 1)
    const ref = await send(customer)
    await approve(cashier, ref, true)
    await expect(customer.getByText('Confirmed bill', { exact: true })).toBeVisible()
    const access = (await (await customer.request.get(f.orders + '/session')).json()).session.key
    await customer.route('**/orders/session', route => route.abort())
    await cashier.getByRole('region', { name: 'Active table sessions' }).getByRole('button', { name: /Table 04/ }).click()
    await cashier.getByRole('button', { name: 'Revoke access' }).click()
    await expect(customer.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    await expect(customer.getByText(/Checking table access/)).toBeVisible()
    expect(await (await customer.request.get(f.orders + '/session')).json()).toEqual({ session: null })
    const attempt = await customer.request.post(f.orders, {
      data: { idempotencyKey: randomBytes(16).toString('hex'), sessionKey: access, items: [{ slug: 'pepsi', quantity: 1 }] },
    })
    expect(attempt.status()).toBe(409)
    await customer.unroute('**/orders/session')
    await customer.reload()
    await expect(customer.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
    await expect(customer.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
    expect(f.data().grants[0].revoked_at).toBeTruthy()
    expect(f.data().orders).toHaveLength(1)
  } finally {
    await context.close()
    await cashier.goto('about:blank').catch(() => {})
    await f.close()
  }
})
