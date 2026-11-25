import express from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database.ts'
import { HttpError } from './http-error.ts'
import { restaurant } from './restaurant.ts'
import type { Sessions } from './sessions.ts'

export type KitchenChange = { kind: 'approved' | 'preparing' | 'ready' | 'served'; reference: string } | { kind: 'settled' }

const transitions = {
  start: ['approved', 'preparing', 'preparation_started_at'],
  ready: ['preparing', 'ready', 'ready_at'],
  serve: ['ready', 'served', 'served_at'],
} as const

export function kitchenRoutes(db: DatabaseSync, sessions: Sessions,
  notify: (change: KitchenChange, browsers: string[]) => void) {
  const router = express.Router()
  const board = db.prepare(`
    SELECT o.id, coalesce(o.public_reference, 'legacy-' || o.id) AS reference, t.number AS tableNumber,
      o.status, o.approved_at AS approvedAt, o.preparation_started_at AS preparationStartedAt,
      o.ready_at AS readyAt, s.closed_at AS sittingClosedAt,
      coalesce(o.is_additional, o.id <> (
        SELECT first.id FROM orders first WHERE first.session_id = o.session_id AND first.approved_at IS NOT NULL
        ORDER BY first.approved_at, first.id LIMIT 1
      )) AS additional
    FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
    JOIN table_sessions s ON s.id = o.session_id
    WHERE o.status IN ('approved', 'preparing', 'ready') AND o.approved_at IS NOT NULL
    ORDER BY o.approved_at, o.id
  `)
  const find = db.prepare(`
    SELECT id, status, approved_at, session_id, pending_browser_hash FROM orders
    WHERE coalesce(public_reference, 'legacy-' || id) = ?
  `)
  const lines = db.prepare(`
    SELECT item_name AS name, quantity, instructions FROM order_items WHERE order_id = ? ORDER BY id
  `)
  const updates = {
    start: db.prepare(`UPDATE orders SET status = ?, ${transitions.start[2]} = CURRENT_TIMESTAMP WHERE id = ?`),
    ready: db.prepare(`UPDATE orders SET status = ?, ${transitions.ready[2]} = CURRENT_TIMESTAMP WHERE id = ?`),
    serve: db.prepare(`UPDATE orders SET status = ?, ${transitions.serve[2]} = CURRENT_TIMESTAMP WHERE id = ?`),
  }

  router.get('/', (_request, response) => {
    response.json({
      restaurant: restaurant.name,
      tickets: board.all().map(({ id, additional, ...ticket }) => ({
        ...ticket, additional: additional === 1, items: lines.all(Number(id)),
      })),
    })
  })

  router.post('/orders/:reference/:action', (request, response) => {
    const { reference, action } = request.params
    if (action !== 'start' && action !== 'ready' && action !== 'serve') {
      throw new HttpError(404, 'KITCHEN_ACTION_NOT_FOUND', 'Kitchen action not found.')
    }
    const [from, to] = transitions[action]
    const browsers = transaction(db, () => {
      const order = find.get(reference)
      if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.')
      if (order.status === to) return null
      if (order.status !== from || !order.approved_at || order.session_id === null) {
        throw new HttpError(409, 'KITCHEN_STATE_CHANGED', 'The order is no longer at this stage. Review the updated ticket.')
      }
      updates[action].run(to, Number(order.id))
      const recipients = new Set(sessions.browserHashes(Number(order.session_id)))
      if (typeof order.pending_browser_hash === 'string') recipients.add(order.pending_browser_hash)
      return [...recipients]
    })
    if (browsers) notify({ kind: to, reference }, browsers)
    response.sendStatus(204)
  })

  return router
}
