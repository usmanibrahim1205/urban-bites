import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { createServer as createVite } from 'vite'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { seedDemo } from '../backend/src/seed.ts'

const password = 'fixture-restaurant-staff'
const key = () => randomBytes(16).toString('hex')

async function fixture() {
  const db = openDatabase(':memory:')
  seedDemo(db)
  const app = createApplication(db, undefined, password)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const table = db.prepare("SELECT id, public_code FROM restaurant_tables WHERE number = '04'").get()
  const orders = '/api/tables/' + table?.public_code + '/orders'
  const staff = '/api/staff'
  const sockets: Socket[] = []

  function api(path: string, cookie?: string, body?: object) {
    return fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  }
  async function customer() {
    const response = await api(orders + '/latest')
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return cookie
  }
  async function login() {
    const response = await api(staff + '/login', undefined, { credential: password })
    assert.equal(response.status, 200)
    const header = response.headers.get('set-cookie')
    assert.ok(header?.includes('HttpOnly') && header.includes('SameSite=Strict'))
    return header.split(';')[0]
  }
  async function connect(cookie?: string, namespace = '') {
    const socket = io(origin + namespace, {
      transports: ['websocket'], extraHeaders: { ...(cookie ? { cookie } : {}), origin },
      reconnection: false, forceNew: true, timeout: 2000,
    })
    sockets.push(socket)
    return socket
  }
  async function submit(cookie: string, sessionKey?: string) {
    return api(orders, cookie, { idempotencyKey: key(), sessionKey, items: [{ slug: 'classic-zinger', quantity: 2, instructions: 'Cut in half' }] })
  }
  async function saved(cookie: string, sessionKey?: string) {
    const response = await submit(cookie, sessionKey)
    assert.equal(response.status, 201)
    return (await response.json()).order
  }
  async function overview(cookie: string) {
    const result = await api(staff + '/overview', cookie)
    assert.equal(result.status, 200)
    return result.json()
  }
  async function session(cookie: string) {
    const response = await api(orders + '/session', cookie)
    assert.equal(response.status, 200)
    return (await response.json()).session
  }
  function decision(cookie: string, order: { reference: string; reviewKey?: string }, type = 'approve', verified = false) {
    return api(staff + '/orders/' + order.reference + '/' + type, cookie, { reviewKey: order.reviewKey, verified })
  }
  async function close() {
    sockets.forEach(socket => socket.disconnect())
    await app.io.close()
    db.close()
  }
  return { db, app, origin, orders, staff, tableId: Number(table?.id), api, customer, login, connect, submit, saved, overview, session, decision, close }
}

test('staff API and Socket.IO access is authenticated, rate limited and revoked on logout', async () => {
  const f = await fixture()
  try {
    const browser = await f.customer()
    assert.equal((await f.api(f.staff + '/overview')).status, 401)
    assert.equal((await f.api(f.staff + '/orders/anything/approve', browser, {})).status, 401)
    const publicSocket = await f.connect()
    const browserSocket = await f.connect(browser)
    await Promise.all([once(publicSocket, 'connect'), once(browserSocket, 'connect')])
    publicSocket.emit('join', 'staff:order-requests')
    const unverifiedCustomer = await f.connect(undefined, '/customer')
    await new Promise<void>(resolve => unverifiedCustomer.once('connect_error', () => resolve()))
    assert.equal(f.app.io.sockets.adapter.rooms.get('staff:order-requests'), undefined)

    const cashier = await f.login()
    const staffSocket = await f.connect(cashier)
    await once(staffSocket, 'connect')
    assert.equal(f.app.io.sockets.adapter.rooms.get('staff:order-requests')?.size, 1)
    const owner = await f.connect(browser, '/customer')
    await once(owner, 'connect')
    const otherBrowser = await f.customer()
    const unrelated = await f.connect(otherBrowser, '/customer')
    await once(unrelated, 'connect')
    const events: string[] = []
    for (const socket of [publicSocket, browserSocket, unrelated]) socket.onAny(event => events.push(event))
    const notice = once(staffSocket, 'order:requested')
    const ownerNotice = once(owner, 'customer:changed')
    const order = await f.saved(browser)
    assert.deepEqual((await notice)[0], { reference: order.reference, tableNumber: '04', status: 'pending' })
    assert.deepEqual((await ownerNotice)[0], { kind: 'submitted' })
    assert.deepEqual(events, [])

    const disconnected = new Promise<void>(resolve => staffSocket.once('disconnect', () => resolve()))
    assert.equal((await f.api(f.staff + '/logout', cashier, {})).status, 204)
    await disconnected
    assert.equal((await f.api(f.staff + '/overview', cashier)).status, 401)
    assert.equal(f.app.io.sockets.adapter.rooms.get('staff:order-requests'), undefined)
    for (let index = 0; index < 5; index++) {
      assert.equal((await f.api(f.staff + '/login', undefined, { credential: 'wrong' })).status, 401)
    }
    const limited = await f.api(f.staff + '/login', undefined, { credential: password })
    assert.equal(limited.status, 429)
    assert.ok(limited.headers.get('retry-after'))
  } finally {
    await f.close()
  }
})

test('atomic initial approvals, concurrency, stale views and rejection preserve one sitting and correct history', async () => {
  const f = await fixture()
  try {
    const cashier = await f.login()
    const a = await f.customer()
    const b = await f.customer()
    const [first, second] = await Promise.all([f.saved(a), f.saved(b)])
    const back = f.db.prepare('SELECT count(*) AS count FROM browser_authorizations')
    assert.equal(back.get()?.count, 0)
    const before = await f.overview(cashier)
    assert.deepEqual(before.orders.map(order => order.classification), ['first', 'first'])
    assert.equal((await f.decision(cashier, before.orders[0])).status, 400)

    f.db.exec(`
      CREATE TRIGGER fail_test_approval BEFORE UPDATE OF status ON orders WHEN NEW.status = 'approved'
      BEGIN SELECT RAISE(ABORT, 'test approval failed'); END;
    `)
    assert.equal((await f.decision(cashier, before.orders[0], 'approve', true)).status, 500)
    assert.equal(back.get()?.count, 0)
    assert.equal((await f.overview(cashier)).sessions.length, 0)
    f.db.exec('DROP TRIGGER fail_test_approval')

    const concurrent = await Promise.all(before.orders.map(order => f.decision(cashier, order, 'approve', true)))
    assert.deepEqual(concurrent.map(response => response.status).sort(), [204, 409])
    const current = await f.overview(cashier)
    assert.equal(current.sessions.length, 1)
    assert.equal(current.sessions[0].orders.length, 1)
    assert.equal(current.sessions[0].confirmedTotalMinor, 110000)
    assert.equal(back.get()?.count, 1)
    const approved = current.sessions[0].orders[0].reference
    assert.ok(approved === first.reference || approved === second.reference)
    assert.equal((await f.decision(cashier, before.orders.find(order => order.reference === approved), 'approve', true)).status, 204)
    assert.equal((await f.overview(cashier)).sessions[0].confirmedTotalMinor, 110000)
    assert.equal(current.orders[0].classification, 'unknown')
    assert.equal((await f.decision(cashier, current.orders[0], 'reject')).status, 204)
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM orders WHERE status = 'rejected' AND rejected_at IS NOT NULL").get()?.count, 1)
    assert.equal(back.get()?.count, 1)
  } finally {
    await f.close()
  }
})

test('authorized orders, verified unknown browser joining and revocation isolate sensitive session information', async () => {
  const f = await fixture()
  try {
    const cashier = await f.login()
    const a = await f.customer()
    const b = await f.customer()
    await f.saved(a)
    const starting = (await f.overview(cashier)).orders[0]
    assert.equal((await f.decision(cashier, starting, 'approve', true)).status, 204)
    const aSession = await f.session(a)
    assert.equal(aSession.confirmedTotalMinor, 110000)
    assert.equal(await f.session(b), null)
    assert.equal((await f.api(f.orders + '/bill', b, { sessionKey: aSession.key })).status, 403)

    const additional = await f.saved(a, aSession.key)
    const unknown = await f.saved(b)
    let state = await f.overview(cashier)
    assert.deepEqual(state.orders.map(order => order.classification), ['additional', 'unknown'])
    assert.equal(state.sessions[0].confirmedTotalMinor, 110000)
    assert.equal(state.sessions[0].pendingTotalMinor, 110000)
    assert.equal((await f.session(a)).pending[0].reference, additional.reference)
    assert.equal(await f.session(b), null)
    assert.equal(f.db.prepare('SELECT session_id FROM orders WHERE public_reference = ?').get(unknown.reference)?.session_id, null)
    assert.equal((await f.decision(cashier, state.orders[1])).status, 400)
    assert.equal((await f.decision(cashier, state.orders[1], 'approve', true)).status, 204)
    assert.equal((await f.session(b)).orders.length, 2)
    assert.equal((await f.session(b)).pending.length, 0)

    state = await f.overview(cashier)
    const sitting = state.sessions[0]
    assert.equal((await f.api(f.staff + '/sessions/' + sitting.id + '/browsers/' + sitting.browsers[0].id + '/revoke', cashier, {})).status, 204)
    assert.equal(await f.session(a), null)
    assert.equal((await f.submit(a, aSession.key)).status, 409)
    assert.equal((await f.decision(cashier, state.orders[0])).status, 409)
    const subsequent = await f.saved(a)
    state = await f.overview(cashier)
    assert.equal(state.orders.find(order => order.reference === subsequent.reference).classification, 'unknown')
    assert.equal(state.orders.find(order => order.reference === additional.reference).classification, 'stale')
    assert.equal((await f.session(b)).confirmedTotalMinor, 220000)
  } finally {
    await f.close()
  }
})

test('bill lock, reopening, concurrent approval and settlement, and the next sitting keep balances isolated', async () => {
  const f = await fixture()
  try {
    const cashier = await f.login()
    const a = await f.customer()
    const b = await f.customer()
    const rejected = await f.saved(b)
    assert.equal((await f.decision(cashier, rejected, 'reject')).status, 204)
    assert.equal((await f.overview(cashier)).sessions.length, 0)
    await f.saved(a)
    assert.equal((await f.decision(cashier, (await f.overview(cashier)).orders[0], 'approve', true)).status, 204)
    const auth = await f.session(a)

    await f.saved(a, auth.key)
    await f.saved(b)
    assert.equal((await f.api(f.orders + '/bill', a, { sessionKey: auth.key })).status, 204)
    assert.equal((await f.submit(a, auth.key)).status, 409)
    assert.equal((await f.submit(b)).status, 409)
    let view = await f.overview(cashier)
    let sitting = view.sessions[0]
    const path = f.staff + '/sessions/' + sitting.id
    const settle = (total: number, revision = sitting.billRevision, confirmed = true) => f.api(path + '/settle', cashier, { totalMinor: total, billRevision: revision, confirmed })
    assert.equal((await settle(110000)).status, 409)
    const oldRevision = sitting.billRevision
    assert.equal((await f.api(path + '/reopen', cashier, { billRevision: oldRevision })).status, 204)
    await f.saved(a, auth.key)
    assert.equal((await f.api(f.orders + '/bill', a, { sessionKey: auth.key })).status, 204)
    assert.equal((await settle(110000, oldRevision)).status, 409)

    view = await f.overview(cashier)
    sitting = view.sessions[0]
    const [toApprove, toReject, last] = view.orders
    assert.equal((await f.decision(cashier, toReject, 'reject')).status, 204)
    assert.equal((await f.decision(cashier, last, 'reject')).status, 204)
    const race = await Promise.all([settle(110000), f.decision(cashier, toApprove)])
    assert.deepEqual(race.map(response => response.status), [409, 204])
    assert.equal((await settle(220000, sitting.billRevision, false)).status, 400)
    assert.equal((await settle(220000)).status, 204)
    assert.equal((await settle(220000)).status, 409)
    assert.equal(await f.session(a), null)
    assert.equal((await f.api(f.orders + '/bill', a, { sessionKey: auth.key })).status, 403)
    assert.equal(f.db.prepare('SELECT settled_total_minor AS total FROM table_sessions WHERE id = ?').get(sitting.id)?.total, 220000)
    const receipt = await (await f.api(f.orders + '/latest', a)).json()
    assert.equal(receipt.order.status, 'rejected')

    const fresh = await f.customer()
    await f.saved(fresh)
    const newSitting = (await f.overview(cashier)).orders[0]
    assert.equal(newSitting.classification, 'first')
    assert.equal((await f.decision(cashier, newSitting, 'approve', true)).status, 204)
    assert.equal(await f.session(a), null)
    assert.equal((await f.session(fresh)).confirmedTotalMinor, 110000)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM table_sessions WHERE table_id = ? AND closed_at IS NULL').get(f.tableId)?.count, 1)

    const earlier = key().slice(0, 16).toUpperCase()
    f.db.prepare(`
      INSERT INTO orders(table_id, public_reference, pending_browser_hash, total_minor, sitting_generation)
      SELECT table_id, ?, pending_browser_hash, total_minor, 0
      FROM orders WHERE public_reference = ?
    `).run(earlier, toApprove.reference)
    const stale = (await f.overview(cashier)).orders.find(order => order.reference === earlier)
    assert.equal(stale.classification, 'stale')
    assert.equal((await f.decision(cashier, stale, 'approve', true)).status, 409)
    assert.equal((await f.decision(cashier, stale, 'reject')).status, 204)
    assert.equal((await f.session(fresh)).confirmedTotalMinor, 110000)
  } finally {
    await f.close()
  }
})

test('the Vite development proxy preserves staff cookies and origin checks for authenticated sockets', async () => {
  const f = await fixture()
  const previousPort = process.env.BACKEND_PORT
  process.env.BACKEND_PORT = new URL(f.origin).port
  let vite: Awaited<ReturnType<typeof createVite>> | undefined
  let socket: Socket | undefined
  try {
    vite = await createVite({
      configFile: 'frontend/vite.config.ts',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = 'http://127.0.0.1:' + address.port
    const signedIn = await fetch(origin + f.staff + '/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ credential: password }),
    })
    assert.equal(signedIn.status, 200)
    const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    socket = io(origin, {
      transports: ['websocket'], extraHeaders: { cookie, origin }, reconnection: false, timeout: 2000,
    })
    await new Promise<void>((resolve, reject) => {
      socket?.once('connect', resolve).once('connect_error', reject)
    })
    assert.equal(f.app.io.sockets.adapter.rooms.get('staff:order-requests')?.size, 1)
  } finally {
    socket?.disconnect()
    if (previousPort === undefined) delete process.env.BACKEND_PORT
    else process.env.BACKEND_PORT = previousPort
    await vite?.close()
    await f.close()
  }
})

test('concurrent decisions, revocation, billing and kitchen transitions preserve historical charges', async () => {
  const f = await fixture()
  try {
    const staff = await f.login()
    const secondStaff = await f.login()
    const a = await f.customer()
    const b = await f.customer()
    const initial = await f.saved(a)
    const review = (await f.overview(staff)).orders[0]
    const decisions = await Promise.all([
      f.decision(staff, review, 'approve', true), f.decision(secondStaff, review, 'reject'),
    ])
    assert.deepEqual(decisions.map(response => response.status).sort(), [204, 409])
    if (decisions[0].status !== 204) {
      const replacement = await f.saved(a)
      const pending = (await f.overview(staff)).orders.find(order => order.reference === replacement.reference)
      assert.equal((await f.decision(staff, pending, 'approve', true)).status, 204)
    }
    const first = (await f.session(a)).orders[0]
    assert.equal(first.items[0].unitPriceMinor, 55000)
    assert.equal(first.totalMinor, 110000)
    f.db.exec("UPDATE menu_items SET price_minor = 57525 WHERE slug = 'classic-zinger'")
    const queued = await f.saved(b)
    const unknown = (await f.overview(staff)).orders.find(order => order.reference === queued.reference)
    assert.equal((await f.decision(staff, unknown, 'approve', true)).status, 204)
    const session = (await f.overview(staff)).sessions[0]
    assert.equal(session.confirmedTotalMinor, 225050)
    const old = await f.session(a)
    const sitting = f.staff + '/sessions/' + session.id
    const race = await Promise.all([
      f.submit(a, old.key), f.api(sitting + '/browsers/' + session.browsers[0].id + '/revoke', secondStaff, {}),
    ])
    assert.ok([201, 409].includes(race[0].status))
    assert.equal(race[1].status, 204)
    assert.equal(await f.session(a), null)
    assert.equal((await f.submit(a, old.key)).status, 409)

    const active = await f.session(b)
    const billRace = await Promise.all([
      f.submit(b, active.key), f.api(f.orders + '/bill', b, { sessionKey: active.key }),
    ])
    assert.equal(billRace[1].status, 204)
    assert.ok([201, 409].includes(billRace[0].status))
    assert.equal((await f.submit(b, active.key)).status, 409)

    const before = await f.overview(staff)
    for (const order of before.orders) {
      if (order.classification === 'stale') assert.equal((await f.decision(staff, order, 'approve', true)).status, 409)
      assert.equal((await f.decision(staff, order, 'reject')).status, 204)
    }
    const revision = before.sessions[0].billRevision
    assert.equal((await f.api(sitting + '/settle', staff, { billRevision: revision, confirmed: true, totalMinor: 225000 })).status, 409)
    const payload = { billRevision: revision, confirmed: true, totalMinor: 225050 }
    const ending = await Promise.all([
      f.api(sitting + '/settle', staff, payload),
      f.api(sitting + '/settle', secondStaff, payload),
      f.api(f.staff + '/kitchen/orders/' + first.reference + '/start', secondStaff, {}),
    ])
    assert.deepEqual(ending.slice(0,2).map(response => response.status).sort(), [204, 409])
    assert.equal(ending[2].status, 204)
    assert.equal(await f.session(b), null)
    assert.deepEqual({ ...f.db.prepare('SELECT status, total_minor FROM orders WHERE public_reference = ?').get(first.reference) },
      { status: 'preparing', total_minor: 110000 })
    assert.equal(f.db.prepare('SELECT settled_total_minor FROM table_sessions WHERE id=?').get(session.id)?.settled_total_minor, 225050)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM table_sessions WHERE closed_at IS NULL').get()?.count, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM browser_authorizations WHERE revoked_at IS NULL').get()?.count, 0)
    assert.ok(initial.reference)
  } finally {
    await f.close()
  }
})
