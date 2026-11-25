import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { Request } from 'express'
import type { BrowserIdentity } from './browser-identity.ts'
import { transaction } from './database.ts'
import { HttpError } from './http-error.ts'
import { restaurant } from './restaurant.ts'
import { digest, requireSameOrigin } from './security.ts'
import type { Notify, Sessions } from './sessions.ts'

const isHex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOrder(value: unknown) {
  if (!record(value) || !isHex32(value.idempotencyKey) ||
      !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 30) {
    throw new HttpError(400, 'INVALID_ORDER', 'Review your cart before sending your order.')
  }

  const items = value.items.map((line: unknown) => {
    if (!record(line) || typeof line.slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(line.slug) ||
        typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) ||
        line.quantity < 1 || line.quantity > 20) {
      throw new HttpError(400, 'INVALID_ITEM', 'Choose a quantity from 1 to 20 for each item.')
    }

    const instructions = line.instructions === undefined ? '' : line.instructions
    if (typeof instructions !== 'string' || instructions.length > 240 || instructions.includes('\0')) {
      throw new HttpError(400, 'INVALID_INSTRUCTIONS', 'Keep special instructions within 240 characters.')
    }
    return { slug: line.slug, quantity: line.quantity, instructions: instructions.trim() }
  })
  return { idempotencyKey: value.idempotencyKey, items }
}

export interface OrderRequestedEvent {
  reference: string
  tableNumber: string
  status: 'pending'
}

export function customerOrderRoutes(db: DatabaseSync, identity: BrowserIdentity, sessions: Sessions,
  notify: Notify, orderRequested: (event: OrderRequestedEvent) => void) {
  const router = express.Router({ mergeParams: true })
  const tableByCode = db.prepare('SELECT id, number, sitting_generation FROM restaurant_tables WHERE public_code = ?')
  const latest = db.prepare(`
    SELECT id FROM orders WHERE table_id = ? AND pending_browser_hash = ? AND public_reference IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `)
  const previous = db.prepare(`
    SELECT id, request_hash FROM orders WHERE pending_browser_hash = ? AND idempotency_key = ?
  `)
  const browserCount = db.prepare(`
    SELECT count(*) AS count FROM orders WHERE pending_browser_hash = ? AND idempotency_key IS NOT NULL
      AND created_at >= datetime('now', '-1 minute')
  `)
  const tableCount = db.prepare(`
    SELECT count(*) AS count FROM orders WHERE table_id = ? AND idempotency_key IS NOT NULL
      AND created_at >= datetime('now', '-10 minutes')
  `)
  const menuItem = db.prepare('SELECT id, name, price_minor, available FROM menu_items WHERE slug = ?')
  const insertOrder = db.prepare(`
    INSERT INTO orders (table_id, pending_browser_hash, public_reference, idempotency_key, request_hash,
      total_minor, sitting_generation, session_id, authorization_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_minor, quantity, instructions)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const orderById = db.prepare(`
    SELECT orders.public_reference AS reference, orders.idempotency_key AS idempotencyKey,
           orders.status, orders.total_minor AS totalMinor, restaurant_tables.number AS tableNumber, s.closed_at
    FROM orders JOIN restaurant_tables ON restaurant_tables.id = orders.table_id
    LEFT JOIN table_sessions s ON s.id = orders.session_id
    WHERE orders.id = ?
  `)
  const linesByOrder = db.prepare(`
    SELECT item_name AS name, unit_price_minor AS unitPriceMinor, quantity, instructions
    FROM order_items WHERE order_id = ? ORDER BY id
  `)

  function getTable(request: Request) {
    const code = request.params.tableCode
    if (!isHex32(code)) throw new HttpError(400, 'INVALID_TABLE_CODE', 'This table link is invalid.')
    const table = tableByCode.get(code)
    if (!table) throw new HttpError(404, 'TABLE_NOT_FOUND', 'This table could not be found.')
    return { id: Number(table.id), generation: Number(table.sitting_generation) }
  }

  function getOrder(id: number | bigint) {
    const order = orderById.get(id)
    if (!order) throw new Error('Order no longer exists.')
    return {
      reference: String(order.reference),
      idempotencyKey: String(order.idempotencyKey),
      status: order.closed_at !== null && order.status !== 'rejected' ? 'session-closed' : String(order.status),
      ...(order.closed_at !== null && ['approved', 'preparing', 'ready', 'served'].includes(String(order.status))
        ? { preparationStatus: String(order.status) } : {}),
      totalMinor: Number(order.totalMinor),
      tableNumber: String(order.tableNumber),
      currency: restaurant.currency,
      items: linesByOrder.all(id),
    }
  }

  router.use((request, response, next) => {
    response.set('Cache-Control', 'private, no-store')
    requireSameOrigin(request)
    next()
  })

  router.get('/latest', (request, response) => {
    const table = getTable(request)
    const hash = identity.hash(request.headers.cookie)
    identity.issue(request, response)
    const found = hash && latest.get(table.id, hash)
    response.json({ order: found ? getOrder(Number(found.id)) : null })
  })

  router.get('/session', (request, response) => {
    const table = getTable(request)
    const hash = identity.hash(request.headers.cookie)
    response.json({ session: hash ? sessions.customerView(table.id, hash) : null })
  })

  router.post('/bill', (request, _response, next) => {
    requireSameOrigin(request)
    next()
  }, express.json({ limit: '2kb' }), (request, response) => {
    const table = getTable(request)
    const hash = identity.hash(request.headers.cookie)
    if (!hash) throw new HttpError(403, 'SESSION_REQUIRED', 'This browser does not have access to the current table bill.')
    const browsers = sessions.requestBill(table.id, hash, request.body?.sessionKey)
    if (browsers.length) notify('bill-requested', browsers)
    response.sendStatus(204)
  })

  router.post('/', (request, _response, next) => {
    requireSameOrigin(request)
    if (!request.is('application/json')) {
      throw new HttpError(415, 'JSON_REQUIRED', 'The order could not be read.')
    }
    next()
  }, express.json({ limit: '32kb' }), (request, response) => {
    const browserHash = identity.hash(request.headers.cookie)
    if (!browserHash) {
      throw new HttpError(401, 'BROWSER_REQUIRED', 'Reload the menu and allow cookies before sending your order.')
    }
    const order = parseOrder(request.body)
    let created = false
    const recipients = [browserHash]

    const result = transaction(db, () => {
      const table = getTable(request)
      const requestHash = digest(JSON.stringify([table.id, order.items]))
      const duplicate = previous.get(browserHash, order.idempotencyKey)
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) {
          throw new HttpError(409, 'ORDER_KEY_CONFLICT', 'This request was already used for a different order.')
        }
        return getOrder(Number(duplicate.id))
      }

      const context = sessions.context(table.id, browserHash)
      if (request.body.sessionKey !== undefined && request.body.sessionKey !== context.key) {
        throw new HttpError(409, 'SESSION_CHANGED', 'The table state changed. Review your order before sending it again.')
      }
      if (context.locked) throw new HttpError(409, 'BILL_REQUESTED', 'Ordering is paused while the bill is being handled.')

      const tableLimited = Number(tableCount.get(table.id)?.count) >= 30
      if (tableLimited || Number(browserCount.get(browserHash)?.count) >= 6) {
        response.set('Retry-After', tableLimited ? '600' : '60')
        throw new HttpError(429, 'ORDER_RATE_LIMIT', 'Too many requests were sent. Please wait before trying again.')
      }

      let total = 0
      const resolved = order.items.map(line => {
        const item = menuItem.get(line.slug)
        if (!item || item.available !== 1) {
          throw new HttpError(422, 'ITEM_UNAVAILABLE', 'An item is no longer available. Refresh the menu and review your cart.')
        }
        total += Number(item.price_minor) * line.quantity
        return { ...line, id: Number(item.id), name: String(item.name), price: Number(item.price_minor) }
      })
      if (!Number.isSafeInteger(total)) throw new HttpError(422, 'INVALID_TOTAL', 'This order amount is too large.')

      const reference = randomBytes(8).toString('hex').toUpperCase()
      const { lastInsertRowid } = insertOrder.run(table.id, browserHash, reference, order.idempotencyKey, requestHash,
        total, table.generation, context.authorizationId === null ? null : context.sessionId, context.authorizationId)
      for (const item of resolved) {
        insertItem.run(lastInsertRowid, item.id, item.name, item.price, item.quantity, item.instructions)
      }
      created = true
      return getOrder(lastInsertRowid)
    })

    if (created) {
      orderRequested({ reference: result.reference, tableNumber: result.tableNumber, status: 'pending' })
      notify('submitted', recipients)
    }
    response.status(created ? 201 : 200).json({ order: result })
  })
  return router
}

