import { randomBytes } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { transaction } from './database.ts'
import { HttpError } from './http-error.ts'
import { digest } from './security.ts'

export type ChangeKind = 'submitted' | 'approved' | 'rejected' | 'session-created' |
  'browser-revoked' | 'bill-requested' | 'ordering-reopened' | 'settled' | 'preparing' | 'ready' | 'served'
export type Notify = (kind: ChangeKind, browsers: string[]) => void

export function createSessions(db: DatabaseSync) {
  const active = db.prepare('SELECT * FROM table_sessions WHERE table_id = ? AND closed_at IS NULL')
  const currentById = db.prepare('SELECT * FROM table_sessions WHERE id = ? AND closed_at IS NULL')
  const authorization = db.prepare(`
    SELECT id FROM browser_authorizations
    WHERE session_id = ? AND browser_identity_hash = ? AND revoked_at IS NULL
  `)
  const activeBrowsers = db.prepare(`
    SELECT a.browser_identity_hash AS hash FROM browser_authorizations a
    JOIN table_sessions s ON s.id = a.session_id AND s.closed_at IS NULL
    WHERE a.session_id = ? AND a.revoked_at IS NULL AND a.browser_identity_hash IS NOT NULL
  `)
  const totals = db.prepare(`
    SELECT coalesce(sum(total_minor), 0) AS total FROM orders
    WHERE session_id = ? AND status IN ('approved','preparing','ready','served')
  `)
  const unresolved = db.prepare(`
    SELECT count(*) AS count FROM orders WHERE table_id = ? AND sitting_generation = ? AND status = 'pending'
  `)
  const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))]
  const browserHashes = (sessionId: number) => activeBrowsers.all(sessionId).map(row => String(row.hash))
  const sessionKey = (sessionId: number, authorizationId: number, hash: string) =>
    digest('table-session:' + sessionId + ':' + authorizationId + ':' + hash)

  function context(tableId: number, hash: string) {
    const current = active.get(tableId)
    const sessionId = current ? Number(current.id) : null
    const grant = sessionId === null ? undefined : authorization.get(sessionId, hash)
    return {
      sessionId,
      authorizationId: grant ? Number(grant.id) : null,
      locked: Boolean(current?.bill_requested_at),
      key: grant && sessionId !== null ? sessionKey(sessionId, Number(grant.id), hash) : null,
    }
  }

  function find(id: number) {
    const row = currentById.get(id)
    if (!row) throw new HttpError(409, 'SESSION_CHANGED', 'This sitting has changed. Review the current table state.')
    return row
  }

  function checkRevision(row: ReturnType<typeof find>, revision: unknown) {
    if (row.bill_revision !== revision) {
      throw new HttpError(409, 'SESSION_CHANGED', 'The bill state changed. Review it before continuing.')
    }
  }

  function confirmedTotal(sessionId: number) {
    return Number(totals.get(sessionId)?.total)
  }

  const lines = db.prepare(`
    SELECT item_name AS name, unit_price_minor AS unitPriceMinor, quantity, instructions
    FROM order_items WHERE order_id = ? ORDER BY id
  `)
  const sessionOrders = db.prepare(`
    SELECT id, public_reference AS reference, status, total_minor AS totalMinor, created_at AS createdAt
    FROM orders WHERE session_id = ? AND status IN ('approved','preparing','ready','served') ORDER BY id
  `)
  const privatePending = db.prepare(`
    SELECT id, public_reference AS reference, status, total_minor AS totalMinor, created_at AS createdAt
    FROM orders WHERE session_id = ? AND authorization_id = ? AND status = 'pending' ORDER BY id
  `)
  const tableOrders = db.prepare(`
    SELECT id, public_reference AS reference, status, total_minor AS totalMinor, created_at AS createdAt
    FROM orders WHERE session_id = ? AND status = 'pending' ORDER BY id
  `)
  const withLines = (rows: ReturnType<typeof sessionOrders.all>) => rows.map(row => ({
    reference: String(row.reference ?? 'Order ' + row.id),
    status: String(row.status), totalMinor: Number(row.totalMinor), createdAt: String(row.createdAt),
    items: lines.all(Number(row.id)),
  }))

  function customerView(tableId: number, hash: string) {
    const auth = context(tableId, hash)
    if (auth.sessionId === null || auth.authorizationId === null) return null
    const orders = withLines(sessionOrders.all(auth.sessionId))
    const pending = withLines(privatePending.all(auth.sessionId, auth.authorizationId))
    return {
      key: auth.key,
      billRequested: auth.locked,
      confirmedTotalMinor: confirmedTotal(auth.sessionId),
      pendingTotalMinor: pending.reduce((sum, order) => sum + Number(order.totalMinor), 0),
      orders,
      pending,
    }
  }

  function requestBill(tableId: number, hash: string, key: unknown) {
    return transaction(db, () => {
      const auth = context(tableId, hash)
      if (auth.sessionId === null || auth.authorizationId === null) {
        throw new HttpError(403, 'SESSION_REQUIRED', 'This browser does not have access to the current table bill.')
      }
      if (key !== auth.key) throw new HttpError(409, 'SESSION_CHANGED', 'The sitting has changed. Reopen your table details.')
      if (auth.locked) return []
      db.prepare('UPDATE table_sessions SET bill_requested_at = CURRENT_TIMESTAMP, bill_revision = bill_revision + 1 WHERE id = ?').run(auth.sessionId)
      return browserHashes(auth.sessionId)
    })
  }

  const orderQuery = `
    SELECT o.*, t.number AS table_number, t.sitting_generation AS current_generation,
           s.id AS current_session_id, a.revoked_at AS grant_revoked, a.browser_identity_hash AS grant_hash
    FROM orders o JOIN restaurant_tables t ON t.id = o.table_id
    LEFT JOIN table_sessions s ON s.table_id = t.id AND s.closed_at IS NULL
    LEFT JOIN browser_authorizations a ON a.id = o.authorization_id
  `
  const queue = db.prepare(orderQuery + " WHERE o.status = 'pending' ORDER BY o.id")
  const byReference = db.prepare(orderQuery + ' WHERE o.public_reference = ?')
  const staffSessions = db.prepare(`
    SELECT s.*, t.number AS table_number, t.sitting_generation AS generation
    FROM table_sessions s JOIN restaurant_tables t ON t.id = s.table_id
    WHERE s.closed_at IS NULL ORDER BY t.number
  `)
  const staffBrowsers = db.prepare(`
    SELECT id, created_at AS authorizedAt FROM browser_authorizations
    WHERE session_id = ? AND revoked_at IS NULL ORDER BY id
  `)

  function classification(order: Record<string, SQLOutput>) {
    if (order.sitting_generation !== order.current_generation || !order.pending_browser_hash) return 'stale'
    if (order.session_id !== null) {
      return order.session_id === order.current_session_id && order.grant_revoked === null &&
        order.grant_hash === order.pending_browser_hash ? 'additional' : 'stale'
    }
    return order.current_session_id === null ? 'first' : 'unknown'
  }

  function reviewKey(order: Record<string, SQLOutput>) {
    return [order.current_generation, order.current_session_id ?? 0, classification(order)].join(':')
  }

  function overview() {
    const sessions = staffSessions.all().map(row => {
      const id = Number(row.id)
      const pending = withLines(tableOrders.all(id))
      return {
        id, tableNumber: row.table_number, openedAt: row.opened_at,
        billRequestedAt: row.bill_requested_at, billRevision: row.bill_revision,
        confirmedTotalMinor: confirmedTotal(id), orders: withLines(sessionOrders.all(id)),
        pending, pendingTotalMinor: pending.reduce((sum, order) => sum + Number(order.totalMinor), 0),
        unresolvedCount: Number(unresolved.get(Number(row.table_id), Number(row.generation))?.count),
        browsers: staffBrowsers.all(id),
      }
    })
    const orders = queue.all().map(order => {
      const items = lines.all(Number(order.id))
      return {
        reference: order.public_reference ?? 'legacy-' + order.id, tableNumber: order.table_number,
        createdAt: order.created_at, totalMinor: order.total_minor, reviewKey: reviewKey(order),
        classification: classification(order), items,
        itemCount: items.reduce((sum, item) => sum + Number(item.quantity), 0),
      }
    })
    return { sessions, orders, tableCount: Number(db.prepare('SELECT count(*) AS count FROM restaurant_tables').get()?.count) }
  }

  function findOrder(reference: string) {
    const legacy = /^legacy-(\d+)$/.exec(reference)
    const order = legacy
      ? db.prepare(orderQuery + ' WHERE o.id = ? AND o.public_reference IS NULL').get(Number(legacy[1]))
      : byReference.get(reference)
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'This order could not be found.')
    return order
  }

  function resolveOrder(reference: string, decision: 'approve' | 'reject', expected: unknown, verified: unknown) {
    return transaction(db, () => {
      const order = findOrder(reference)
      const target = decision === 'approve' ? 'approved' : 'rejected'
      if (order.status === target || (decision === 'approve' && order.approved_at !== null)) return null
      if (order.status !== 'pending') throw new HttpError(409, 'ORDER_RESOLVED', 'This order has already been resolved.')
      const browser = typeof order.pending_browser_hash === 'string' ? order.pending_browser_hash : undefined
      const current = order.current_session_id === null ? null : Number(order.current_session_id)
      if (decision === 'reject') {
        db.prepare("UPDATE orders SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(order.id))
        return { kind: 'rejected' as const, browsers: distinct([browser]) }
      }

      const type = classification(order)
      if (!browser || type === 'stale' || reviewKey(order) !== expected) {
        throw new HttpError(409, 'ORDER_REVIEW_CHANGED', 'The table or browser authorization changed. Review the request again.')
      }
      if (type !== 'additional' && verified !== true) {
        throw new HttpError(400, 'VERIFICATION_REQUIRED', 'Verify that the customer is seated at this table before approving.')
      }

      const sessionId = current ?? Number(db.prepare('INSERT INTO table_sessions(table_id) VALUES (?)').run(Number(order.table_id)).lastInsertRowid)
      let grant = type === 'additional' ? Number(order.authorization_id) : Number(authorization.get(sessionId, browser)?.id ?? 0)
      if (!grant) {
        grant = Number(db.prepare(`
          INSERT INTO browser_authorizations(session_id, token_hash, browser_identity_hash) VALUES (?, ?, ?)
        `).run(sessionId, randomBytes(32).toString('hex'), browser).lastInsertRowid)
      }
      db.prepare(`
        UPDATE orders SET session_id = ?, authorization_id = ?, status = 'approved', approved_at = CURRENT_TIMESTAMP, is_additional = ?
        WHERE id = ?
      `).run(sessionId, grant, current === null ? 0 : 1, Number(order.id))
      return { kind: current === null ? 'session-created' as const : 'approved' as const, browsers: distinct([browser, ...browserHashes(sessionId)]) }
    })
  }

  function revoke(sessionId: number, authorizationId: number) {
    return transaction(db, () => {
      find(sessionId)
      const row = db.prepare(`
        UPDATE browser_authorizations SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND session_id = ? AND revoked_at IS NULL RETURNING browser_identity_hash
      `).get(authorizationId, sessionId)
      if (!row) throw new HttpError(409, 'BROWSER_CHANGED', 'This browser no longer has access.')
      return distinct([typeof row.browser_identity_hash === 'string' ? row.browser_identity_hash : undefined, ...browserHashes(sessionId)])
    })
  }

  function reopen(sessionId: number, revision: unknown) {
    return transaction(db, () => {
      const row = find(sessionId)
      checkRevision(row, revision)
      if (!row.bill_requested_at) throw new HttpError(409, 'BILL_NOT_REQUESTED', 'Ordering is already open.')
      db.prepare('UPDATE table_sessions SET bill_requested_at = NULL, bill_revision = bill_revision + 1 WHERE id = ?').run(sessionId)
      return browserHashes(sessionId)
    })
  }

  function settle(sessionId: number, revision: unknown, confirmed: unknown, expectedTotal: unknown) {
    return transaction(db, () => {
      const row = find(sessionId)
      checkRevision(row, revision)
      if (!row.bill_requested_at) throw new HttpError(409, 'BILL_NOT_REQUESTED', 'The customer must request the bill before settlement.')
      if (confirmed !== true) throw new HttpError(400, 'SETTLEMENT_CONFIRMATION_REQUIRED', 'Confirm that payment has been collected.')
      const tableId = Number(row.table_id)
      const generation = Number(db.prepare('SELECT sitting_generation FROM restaurant_tables WHERE id = ?').get(tableId)?.sitting_generation)
      if (Number(unresolved.get(tableId, generation)?.count) > 0) {
        throw new HttpError(409, 'PENDING_ORDERS', 'Resolve all pending requests for this sitting before settling.')
      }
      const total = confirmedTotal(sessionId)
      if (expectedTotal !== total) throw new HttpError(409, 'BILL_CHANGED', 'The total has changed. Review the current bill.')
      const browsers = browserHashes(sessionId)
      db.prepare('UPDATE table_sessions SET closed_at = CURRENT_TIMESTAMP, settled_total_minor = ? WHERE id = ?').run(total, sessionId)
      db.prepare('UPDATE browser_authorizations SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = ? AND revoked_at IS NULL').run(sessionId)
      db.prepare('UPDATE restaurant_tables SET sitting_generation = sitting_generation + 1 WHERE id = ?').run(tableId)
      return browsers
    })
  }

  return { context, customerView, requestBill, overview, resolveOrder, revoke, reopen, settle, browserHashes }
}

type SQLOutput = Exclude<SQLInputValue, boolean | undefined>
export type Sessions = ReturnType<typeof createSessions>
