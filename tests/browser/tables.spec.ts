import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { createApplication } from '../../backend/src/app.ts'
import { openDatabase } from '../../backend/src/database.ts'
import { seedDemo } from '../../backend/src/seed.ts'

const password = 'tables-browser-fixture'
test.describe.configure({ timeout: 75_000 })
let origin: string
let expected: Map<string, string>
let app: ReturnType<typeof createApplication>
let shutdown: () => Promise<void>

test.beforeEach(async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  expected = new Map(db.prepare('SELECT number, public_code FROM restaurant_tables').all()
    .map(row => [String(row.number), String(row.public_code)]))
  app = createApplication(db, resolve('frontend/dist'), password)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  origin = 'http://127.0.0.1:' + address.port
  shutdown = async () => { await app.io.close(); db.close() }
})
test.afterEach(async ({ page }) => { await page.close(); await shutdown() })

async function login(page: Page, url = '/tables') {
  await page.goto(origin + url)
  await page.getByLabel('Staff password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible()
}

const tile = (page: Page, number: string) => page.getByRole('region', { name: 'Restaurant tables' })
  .getByRole('button', { name: new RegExp('Table ' + number) })

async function applyBase(page: Page, base: string) {
  await page.getByLabel('QR base URL').fill(base)
  await page.getByRole('button', { name: 'Apply address' }).click()
}

async function send(page: Page) {
  await page.getByRole('button', { name: 'Add Classic Zinger' }).click()
  await page.getByRole('button', { name: /Add to cart/ }).click()
  await page.getByRole('button', { name: /View cart/ }).click()
  await page.getByRole('button', { name: 'Send order', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  return page.locator('.order-reference strong').innerText()
}

async function capture(page: Page, name: string) {
  const folder = resolve('test-results/screenshots')
  await mkdir(folder, { recursive: true })
  await page.screenshot({ path: resolve(folder, name + '.png'), fullPage: true })
}

async function decodeSvg(image: Locator) {
  const pixels = await image.evaluate(async element => {
    const image = element as HTMLImageElement
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0, 512, 512)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const png = PNG.sync.read(Buffer.from(pixels, 'base64'))
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data
}

test('table state follows live orders, bill requests and settlement while the QR remains permanent', async ({ page, browser }, info) => {
  const staffContext = await browser.newContext()
  const customerContext = await browser.newContext()
  const cashier = await staffContext.newPage()
  try {
    await page.goto(origin + '/tables')
    await expect(page.getByRole('heading', { name: 'Restaurant tables' })).toHaveCount(0)
    await login(page)
    await expect(page.getByRole('region', { name: 'Restaurant tables' }).getByRole('button')).toHaveCount(10)
    await expect(page.getByText(/loopback address only reaches/)).toBeVisible()
    await tile(page, '04').click()
    const details = page.getByRole('region', { name: 'Table 04 details' })
    await expect(details.getByText('No active sitting.')).toBeVisible()
    await applyBase(page, 'https://user:bad@example.test')
    await expect(page.getByRole('alert')).toContainText('no credentials')
    await applyBase(page, origin + '///')
    await expect(details.getByLabel('Customer menu link')).toHaveValue(origin + '/menu/' + expected.get('04'))
    const qr = details.getByRole('img')
    expect(await decodeSvg(qr)).toBe(origin + '/menu/' + expected.get('04'))
    await expect(details.getByRole('link', { name: 'Open customer menu' })).toHaveAttribute('href', origin + '/menu/' + expected.get('04'))
    await details.getByRole('button', { name: 'Copy customer menu link' }).click()
    await expect(details.getByRole('status')).toHaveText(/Customer link copied|Link selected/)
    for (const format of ['SVG', 'PNG']) {
      const download = page.waitForEvent('download')
      await details.getByRole('button', { name: 'Download ' + format }).click()
      expect((await download).suggestedFilename()).toBe('urban-bites-table-04.' + format.toLowerCase())
    }

    await login(cashier, '/cashier')
    const cashierUrl = await details.getByRole('link', { name: 'Open Table 04 in cashier' }).getAttribute('href')
    await cashier.goto(origin + cashierUrl)
    await expect(cashier.getByRole('link', { name: 'Show all tables' })).toBeVisible()
    const publicLink = await details.getByRole('link', { name: 'Open customer menu' }).getAttribute('href')
    const customer = await customerContext.newPage()
    await customer.goto(publicLink!)
    const rejected = await send(customer)
    await expect(tile(page, '04')).toContainText('First order awaiting verification')
    await expect(tile(page, '04')).toContainText('1 pending request')
    const queue = cashier.getByRole('region', { name: 'Incoming orders' })
    await queue.getByRole('button', { name: new RegExp(rejected) }).click()
    await cashier.getByRole('button', { name: 'Reject order' }).click()
    await expect(tile(page, '04')).toContainText('Available')
    await customer.getByRole('button', { name: 'Back to menu' }).click()

    const ref = await send(customer)
    await queue.getByRole('button', { name: new RegExp(ref) }).click()
    await cashier.getByRole('checkbox').check()
    await cashier.getByRole('button', { name: 'Approve order' }).click()
    await expect(tile(page, '04')).toContainText('Occupied')
    await expect(details.getByText(ref, { exact: true })).toBeVisible()
    await expect(details.getByText('PKR 550', { exact: true })).toBeVisible()
    await capture(page, 'phase5-tables-' + info.project.name)

    await page.context().setOffline(true)
    for (const socket of app.io.sockets.sockets.values()) socket.conn.close()
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible()
    await customer.getByRole('button', { name: 'Request bill' }).click()
    await page.context().setOffline(false)
    await expect(tile(page, '04')).toContainText('Bill requested')
    await expect(page.getByText('Live updates', { exact: true })).toBeVisible()
    await cashier.getByRole('button', { name: 'Settle bill' }).click()
    await cashier.getByRole('button', { name: 'Confirm settlement' }).click()
    await expect(tile(page, '04')).toContainText('Available')
    await page.reload()
    await tile(page, '04').click()
    await expect(details.getByLabel('Customer menu link')).toHaveValue(publicLink!)
    expect(await decodeSvg(details.getByRole('img'))).toBe(publicLink)
    await expect(customer.getByRole('heading', { name: 'Session closed' })).toBeVisible()
  } finally {
    await page.context().setOffline(false)
    await staffContext.close()
    await customerContext.close()
  }
})

test('individual and bulk print previews carry the correct independently decoded SVGs and fit A4 pages', async ({ page }, info) => {
  await login(page)
  const base = 'https://orders.example.test'
  await applyBase(page, base)
  await tile(page, '04').click()
  await page.getByRole('button', { name: 'Print table sign' }).click()
  const individual = page.getByRole('article', { name: 'Table 04 sign' })
  await expect(individual.getByText('Scan. Order. Enjoy.')).toBeVisible()
  expect(await decodeSvg(individual.getByRole('img'))).toBe(base + '/menu/' + expected.get('04'))
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCSS('background-color', 'rgb(194, 65, 12)')
  await capture(page, 'phase5-single-sign-' + info.project.name)
  await page.getByRole('button', { name: 'Back to tables' }).click()
  await page.getByRole('button', { name: 'Print all QR codes' }).click()
  await expect(page.getByRole('article')).toHaveCount(10)
  await Promise.all([...expected].map(async ([number, code]) => {
    const sign = page.getByRole('article', { name: `Table ${number} sign`, exact: true })
    await expect(sign).toHaveCount(1)
    expect(await decodeSvg(sign.getByRole('img'))).toBe(base + '/menu/' + code)
  }))
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeEnabled()
  await capture(page, 'phase5-bulk-print-' + info.project.name)
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await expect(page.getByText('Confirmed bill', { exact: true })).toHaveCount(0)
  const styled = await page.locator('.table-sign').first().evaluate(el => getComputedStyle(el).breakInside)
  expect(styled).toBe('avoid')
  const pdf = await page.pdf({ preferCSSPageSize: true })
  expect([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(3)
})
