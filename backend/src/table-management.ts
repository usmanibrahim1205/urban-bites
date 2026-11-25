import express from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { config, port } from './config.ts'
import { HttpError } from './http-error.ts'
import { restaurant } from './restaurant.ts'
import type { Sessions } from './sessions.ts'
import { createTableQr, createTableQrPng, parseQrOrigin, qrOriginSettings } from './table-qr.ts'

export function tableManagement(db: DatabaseSync, sessions: Sessions) {
  const router = express.Router()
  const counts = db.prepare(`
    SELECT t.number, t.public_code AS tableCode, count(o.id) AS pendingCount,
           coalesce(sum(o.total_minor), 0) AS pendingTotalMinor
    FROM restaurant_tables t
    LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'pending' AND o.sitting_generation = t.sitting_generation
    GROUP BY t.id ORDER BY t.number
  `)
  const tableByNumber = db.prepare('SELECT public_code FROM restaurant_tables WHERE number = ?')

  function validated(value: unknown) {
    try {
      return parseQrOrigin(value)
    } catch {
      throw new HttpError(400, 'INVALID_QR_BASE', 'Enter an HTTP or HTTPS address with no credentials, path, query, or fragment.')
    }
  }

  router.get('/', (_request, response) => {
    const defaultBase = qrOriginSettings(validated(config.publicOrigin ?? process.env.QR_BASE_URL ?? 'http://localhost:' + port('FRONTEND_PORT', 5173)))
    const current = new Map(sessions.overview().sessions.map(session => [session.tableNumber, session]))
    const tables = counts.all().map(row => {
      const active = current.get(row.number)
      const state = active ? (active.billRequestedAt ? 'bill-requested' : 'occupied')
        : Number(row.pendingCount) ? 'awaiting-verification' : 'available'
      return {
        ...row,
        state,
        sitting: active ? {
          openedAt: active.openedAt, confirmedTotalMinor: active.confirmedTotalMinor,
          authorizedBrowserCount: active.browsers.length,
          orders: active.orders.map(({ reference, status }) => ({ reference, status })),
        } : null,
      }
    })
    response.json({ restaurant: restaurant.name, currency: restaurant.currency, defaultBase, tables })
  })

  router.post('/qr-base', (request, response) => {
    response.json(qrOriginSettings(validated(request.body?.baseUrl)))
  })

  router.get('/:number/qr/:format', async (request, response) => {
    const { number, format } = request.params
    if (format !== 'svg' && format !== 'png') throw new HttpError(404, 'QR_FORMAT_NOT_FOUND', 'QR image format not supported.')
    const table = tableByNumber.get(number)
    if (typeof table?.public_code !== 'string') throw new HttpError(404, 'TABLE_NOT_FOUND', 'Table not found.')
    const origin = validated(request.query.baseUrl)
    if (request.query.download === '1') response.attachment('urban-bites-table-' + number + '.' + format)
    if (format === 'svg') response.type('image/svg+xml').send(await createTableQr(origin, table.public_code))
    else response.type('image/png').send(await createTableQrPng(origin, table.public_code))
  })

  return router
}
