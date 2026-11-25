import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { Server } from 'socket.io'
import { restaurant } from './restaurant.ts'
import { HttpError } from './http-error.ts'
import { customerOrderRoutes } from './customer-orders.ts'
import { createBrowserIdentity } from './browser-identity.ts'
import { createStaffAuth } from './staff-auth.ts'
import { staffRoutes } from './staff-routes.ts'
import { createSessions } from './sessions.ts'
import type { Notify } from './sessions.ts'
import { sameOrigin } from './security.ts'
import { kitchenRoutes } from './kitchen.ts'
import { tableManagement } from './table-management.ts'
import type { KitchenChange } from './kitchen.ts'
import { config } from './config.ts'

const handleError: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) return next(error)
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof URIError) {
    response.status(400).json({ error: { code: 'INVALID_PATH', message: 'Invalid URL path.' } })
    return
  }
  const parserStatus = new Map([
    ['entity.parse.failed', 400], ['request.aborted', 400], ['request.size.invalid', 400],
    ['entity.too.large', 413], ['encoding.unsupported', 415], ['charset.unsupported', 415],
  ]).get(error?.type)
  if (parserStatus) {
    response.status(parserStatus).json({ error: { code: 'INVALID_BODY', message: 'The request could not be read.' } })
    return
  }
  console.error(error?.code === 'ERR_SQLITE_ERROR' ? 'Request failed during a database operation.' : 'Unexpected request failure.')
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } })
}

export function createApplication(db: DatabaseSync, frontendDist?: string, staffCredential = process.env.STAFF_CREDENTIAL) {
  const app = express()
  app.disable('x-powered-by')
  if (config.render) app.set('trust proxy', 1)
  const api = express.Router()
  const server = createServer(app)
  const io = new Server(server, {
    serveClient: false,
    allowRequest: config.render ? (request, callback) => {
      const { origin, host } = request.headers
      callback(null, sameOrigin(origin, host, request.headers['sec-fetch-site']?.toString()) &&
        (request.headers.upgrade?.toLowerCase() !== 'websocket' || origin === config.publicOrigin))
    } : undefined,
  })
  const staffRoom = 'staff:order-requests'
  const staffSocketRoom = (hash: string) => 'staff-session:' + hash
  const browserRoom = (hash: string) => 'browser:' + hash
  const identity = createBrowserIdentity(db)
  const sessions = createSessions(db)
  const staff = createStaffAuth(db, staffCredential, hash => io.in(staffSocketRoom(hash)).disconnectSockets())
  const customers = io.of('/customer')

  io.on('connection', socket => {
    const { cookie, origin, host } = socket.handshake.headers
    if (!sameOrigin(origin, host, socket.handshake.headers['sec-fetch-site']?.toString())) return
    const grant = staff.authenticate(cookie)
    if (!grant) return
    void socket.join([staffRoom, staffSocketRoom(grant.hash)])
    const expiry = setTimeout(() => socket.disconnect(), Math.max(0, grant.expiresAt - Date.now()))
    expiry.unref()
    socket.once('disconnect', () => clearTimeout(expiry))
  })

  customers.use((socket, next) => {
    const { cookie, origin, host } = socket.handshake.headers
    const hash = identity.hash(cookie)
    if (!hash || !sameOrigin(origin, host, socket.handshake.headers['sec-fetch-site']?.toString())) {
      next(new Error('Browser identity required'))
      return
    }
    socket.data.browserHash = hash
    next()
  })
  customers.on('connection', socket => { void socket.join(browserRoom(socket.data.browserHash)) })

  const notify: Notify = (kind, browsers) => {
    io.to(staffRoom).emit('cashier:changed', { kind })
    if (browsers.length) customers.to(browsers.map(browserRoom)).emit('customer:changed', { kind })
  }

  const categories = db.prepare('SELECT id, slug, name FROM menu_categories ORDER BY display_order, id')
  const items = db.prepare(`
    SELECT slug, name, description, price_minor AS priceMinor, available
    FROM menu_items WHERE category_id = ? ORDER BY display_order, id
  `)
  const tables = db.prepare('SELECT number, public_code AS tableCode FROM restaurant_tables ORDER BY number')
  const tableByCode = db.prepare('SELECT number, public_code AS tableCode FROM restaurant_tables WHERE public_code = ?')
  const ping = db.prepare('SELECT 1')

  api.get('/health', (_request, response) => {
    ping.get()
    response.json({ status: 'ok' })
  })
  api.get('/menu', (_request, response) => {
    response.json({
      restaurant: restaurant.name,
      currency: restaurant.currency,
      categories: categories.all().map(({ id, slug, name }) => ({
        slug,
        name,
        items: items.all(Number(id)).map(item => ({ ...item, available: item.available === 1 })),
      })),
    })
  })
  api.get('/demo/tables', (_request, response) => {
    response.json({ restaurant: restaurant.name, tables: tables.all() })
  })
  api.get('/tables/:tableCode', (request, response) => {
    const { tableCode } = request.params
    if (!/^[0-9a-f]{32}$/.test(tableCode)) {
      throw new HttpError(400, 'INVALID_TABLE_CODE', 'Invalid table code format.')
    }
    const table = tableByCode.get(tableCode)
    if (!table) throw new HttpError(404, 'TABLE_NOT_FOUND', 'Table code not found.')
    response.json({ table })
  })

  const kitchenChanged = (change: KitchenChange) => io.to(staffRoom).emit('kitchen:changed', change)
  const kitchen = kitchenRoutes(db, sessions, (change, browsers) => {
    kitchenChanged(change)
    notify(change.kind, browsers)
  })
  api.use('/staff', staffRoutes(staff, sessions, notify, kitchen, kitchenChanged, tableManagement(db, sessions)))
  api.use('/tables/:tableCode/orders', customerOrderRoutes(db, identity, sessions, notify, event => {
    io.to(staffRoom).emit('order:requested', event)
  }))
  api.use(() => { throw new HttpError(404, 'NOT_FOUND', 'API route not found.') })
  app.use('/api', api)

  if (frontendDist && existsSync(join(frontendDist, 'index.html'))) {
    app.use(express.static(frontendDist))
    app.get(['/', '/menu/:tableCode', '/cashier', '/kitchen', '/tables'], (_request, response) => {
      response.sendFile(join(frontendDist, 'index.html'))
    })
  }

  app.use(() => { throw new HttpError(404, 'NOT_FOUND', 'Page not found.') })
  app.use(handleError)

  return { server, io }
}
