import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createApplication } from '../../backend/src/app.ts'
import { openDatabase } from '../../backend/src/database.ts'
import { seedDemo } from '../../backend/src/seed.ts'

let origin: string
let codeA: string
let codeB: string
let shutdown: () => Promise<void>

test.beforeEach(async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  db.exec("UPDATE menu_items SET available = 0 WHERE slug = 'mineral-water'")
  const app = createApplication(db, resolve('frontend/dist'))
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Test server failed to start')
  origin = `http://127.0.0.1:${address.port}`
  const tables = db.prepare('SELECT public_code FROM restaurant_tables ORDER BY number LIMIT 2').all()
  codeA = String(tables[0].public_code)
  codeB = String(tables[1].public_code)
  shutdown = async () => { await app.io.close(); db.close() }
})

test.afterEach(async ({ page }) => {
  await page.close()
  await shutdown?.()
})

async function openMenu(page: Page, code = codeA) {
  await page.goto(`${origin}/menu/${code}`)
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible()
}

async function addBurger(page: Page, note = '', quantity = 1) {
  await page.getByRole('button', { name: 'Add Classic Zinger' }).click()
  const detail = page.getByRole('dialog', { name: 'Classic Zinger' })
  await expect(detail).toBeVisible()
  if (note) await detail.getByLabel('Special instructions').fill(note)
  for (let index = 1; index < quantity; index++) {
    await detail.getByRole('button', { name: 'Increase Classic Zinger quantity' }).click()
  }
  await detail.getByRole('button', { name: /Add to cart/ }).click()
  await expect(detail).toHaveCount(0)
}

test('loads the menu, navigates categories and keeps cart lines and tables separate', async ({ page }, testInfo) => {
  let releaseMenu: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseMenu = resolve })
  await page.route('**/api/menu', async route => { await gate; await route.continue() }, { times: 1 })
  await page.goto(`${origin}/menu/${codeA}`)
  await expect(page.getByText('Loading the menu…')).toBeVisible()
  releaseMenu()
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible()
  await expect(page.getByText('Table 01', { exact: true })).toBeVisible()
  await expect(page.locator('.menu-item')).toHaveCount(15)
  const width = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  expect(width).toBe(true)
  await expect(page.locator('.menu-hero img')).toHaveJSProperty('complete', true)
  expect(await page.locator('.menu-hero img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const screenshotDir = resolve('test-results/screenshots')
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, `menu-${testInfo.project.name}.png`) })

  const nav = page.getByRole('navigation', { name: 'Menu categories' })
  await nav.getByRole('link', { name: 'Drinks' }).click()
  await expect(nav.getByRole('link', { name: 'Drinks' })).toHaveAttribute('aria-current', 'location')
  await expect(page.getByRole('heading', { name: 'Drinks' })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Add Mineral Water' })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Burgers' }).click()

  await page.getByRole('button', { name: 'Add Classic Zinger' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, `item-${testInfo.project.name}.png`) })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await addBurger(page, 'No lettuce', 2)
  await addBurger(page, 'Extra napkins')
  await page.getByRole('button', { name: /View cart/ }).click()
  const cart = page.getByRole('dialog', { name: 'Your cart' })
  await expect(cart.getByText('No lettuce')).toBeVisible()
  await expect(cart.getByText('Extra napkins')).toBeVisible()
  await expect(cart.getByText(/PKR\s*1,650/)).toBeVisible()
  await cart.getByRole('button', { name: 'Increase Classic Zinger quantity' }).first().click()
  await expect(cart.getByText(/PKR\s*2,200/)).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, `cart-${testInfo.project.name}.png`) })
  await cart.getByRole('button', { name: 'Remove Classic Zinger' }).last().click()
  await expect(cart.getByText('Extra napkins')).toHaveCount(0)
  await cart.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /View cart.*1,650/ })).toBeVisible()
  await openMenu(page, codeB)
  await expect(page.getByText('Table 02', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /View cart/ })).toHaveCount(0)
  await openMenu(page)
  await expect(page.getByRole('button', { name: /View cart.*1,650/ })).toBeVisible()
})

test('handles a failed submission, suppresses duplicate clicks and restores a pending receipt', async ({ page, browser }, testInfo) => {
  await openMenu(page)
  await addBurger(page, 'No lettuce', 2)
  await page.getByRole('button', { name: /View cart/ }).click()
  const send = page.getByRole('button', { name: 'Send order', exact: true })
  const routePattern = '**/orders'
  let posts = 0
  await page.route(routePattern, async route => {
    posts++
    if (posts === 1) {
      await route.fulfill({ status: 422, json: { error: { message: 'An item is no longer available.' } } })
      return
    }
    await route.continue()
  })
  await send.click()
  await expect(page.getByRole('alert')).toHaveText('An item is no longer available.')
  await expect(send).toBeEnabled()
  await send.evaluate(button => {
    const submit = button as HTMLButtonElement
    submit.click()
    submit.click()
  })
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  expect(posts).toBe(2)
  await expect(page.getByText('Awaiting confirmation')).toBeVisible()
  await expect(page.getByText('2 × Classic Zinger')).toBeVisible()
  await expect(page.getByText('No lettuce')).toBeVisible()
  const reference = await page.locator('.order-reference strong').innerText()
  expect(reference).toMatch(/^[0-9A-F]{16}$/)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  await expect(page.getByText(reference)).toBeVisible()
  const screenshotDir = resolve('test-results/screenshots')
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, `confirmation-${testInfo.project.name}.png`) })

  const other = await browser.newContext()
  try {
    const visitor = await other.newPage()
    await openMenu(visitor)
    await expect(visitor.getByText(reference)).toHaveCount(0)
  } finally {
    await other.close()
  }
})

test('recovers a saved order after the response is lost and the page is refreshed', async ({ page }) => {
  await openMenu(page)
  await addBurger(page)
  await page.getByRole('button', { name: /View cart/ }).click()
  await page.route('**/orders', async route => {
    const submitted = await route.fetch()
    expect(submitted.status()).toBe(201)
    await route.abort()
  }, { times: 1 })
  await page.getByRole('button', { name: 'Send order', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Retry to check safely.')
  await expect(page.getByRole('button', { name: 'Retry order' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Order sent' })).toBeVisible()
  await expect(page.getByRole('button', { name: /View cart/ })).toHaveCount(0)
})

test('rejects invalid tables and offers a retry after a connection failure', async ({ page }) => {
  await page.goto(origin + '/menu/invalid')
  await expect(page.getByRole('alert')).toContainText('Scan the QR code')
  await page.goto(origin + '/menu/' + '0'.repeat(32))
  await expect(page.getByRole('alert')).toContainText('Scan the QR code')
  await expect(page.getByRole('button', { name: /Send order/ })).toHaveCount(0)
  await page.route('**/api/menu', route => route.abort(), { times: 1 })
  await page.goto(origin + '/menu/' + codeA)
  await expect(page.getByRole('alert')).toContainText('Check your connection')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible()
})
