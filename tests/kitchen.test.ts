import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { io } from 'socket.io-client'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { migrateOrders } from '../backend/src/order-migration.ts'
import { migrateSessions } from '../backend/src/session-migration.ts'
import { schema } from '../backend/src/schema.ts'
import { seedDemo } from '../backend/src/seed.ts'

const password = 'kitchen-test-fixture'
const kitchen = '/api/staff/kitchen'
const staff = '/api/staff'

async function start(db: DatabaseSync) {
  const app = createApplication(db, undefined, password)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const table = db.prepare("SELECT public_code FROM restaurant_tables WHERE number='04'").get()
  const orders = '/api/tables/' + table?.public_code + '/orders'
  const api = (path: string, cookie?: string, payload?: object) => fetch(origin + path, {
    method: payload ? 'POST' : 'GET',
    headers: { ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json', origin } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  async function cookie(path: string, body?: object) {
    const response = await api(path, undefined, body)
    assert.equal(response.status, 200)
    const result = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(result)
    return result
  }
  const login = () => cookie(staff + '/login', { credential: password })
  const customer = () => cookie(orders + '/latest')
  const overview = async (token: string) => (await api(staff + '/overview', token)).json()
  const board = async (token: string) => (await api(kitchen, token)).json()
  const change = (token: string | undefined, reference: string, action: string) => api(kitchen + '/orders/' + reference + '/' + action, token, {})
  async function submit(token: string) {
    const response = await api(orders, token, {
      idempotencyKey: randomBytes(16).toString('hex'),
      items: [{ slug: 'classic-zinger', quantity: 1, instructions: 'No lettuce' }, { slug: 'classic-zinger', quantity: 2, instructions: 'Cut in half' }],
    })
    assert.equal(response.status, 201)
    return (await response.json()).order
  }
  async function decide(token: string, reference: string, action = 'approve') {
    const reviewed = (await overview(token)).orders.find(order => order.reference === reference)
    return api(staff + '/orders/' + reference + '/' + action, token, { reviewKey: reviewed.reviewKey, verified: true })
  }
  async function close() { await app.io.close(); db.close() }
  return { origin, api, login, customer, overview, board, change, submit, decide, close, orders }
}

test('kitchen enforces eligibility, authenticates events and preserves totals across concurrent lifecycle actions', { timeout: 15000 }, async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  const f = await start(db)
  const connections: ReturnType<typeof io>[] = []
  try {
    const cashier = await f.login()
    const owner = await f.customer()
    const other = await f.customer()
    const connect = (namespace: string, cookie?: string) => {
      const socket = io(f.origin + namespace, { transports: ['websocket'], forceNew: true, extraHeaders: cookie ? { cookie } : {} })
      connections.push(socket)
      return socket
    }
    const staffSocket = connect('', cashier)
    const publicSocket = connect('')
    const ownerSocket = connect('/customer', owner)
    const otherSocket = connect('/customer', other)
    await Promise.all(connections.map(socket => once(socket, 'connect')))
    const leaks: unknown[] = []
    publicSocket.onAny(event => leaks.push(event))
    otherSocket.onAny((event, payload) => leaks.push([event, payload.kind]))
    publicSocket.emit('join', 'staff:order-requests')
    assert.equal((await f.api(kitchen)).status, 401)
    assert.equal((await f.api(kitchen, owner)).status, 401)
    const sent = await f.submit(owner)
    assert.equal((await f.change(undefined, sent.reference, 'start')).status, 401)
    assert.equal((await f.change(cashier, sent.reference, 'start')).status, 409)
    assert.deepEqual((await f.board(cashier)).tickets, [])
    const approved = once(staffSocket, 'kitchen:changed')
    assert.equal((await f.decide(cashier, sent.reference)).status, 204)
    assert.deepEqual((await approved)[0], { kind: 'approved', reference: sent.reference })
    const rejected = await f.submit(other)
    assert.equal((await f.decide(cashier, rejected.reference, 'reject')).status, 204)
    assert.equal((await f.change(cashier, rejected.reference, 'start')).status, 409)
    const additional = await f.submit(owner)
    assert.equal((await f.board(cashier)).tickets.length, 1)
    assert.equal((await f.decide(cashier, additional.reference)).status, 204)
    const tickets = (await f.board(cashier)).tickets
    assert.deepEqual(tickets.map(ticket => [ticket.reference, ticket.additional]), [[sent.reference, false], [additional.reference, true]])
    assert.deepEqual(Object.keys(tickets[0]).sort(), ['additional', 'approvedAt', 'items', 'preparationStartedAt', 'readyAt', 'reference', 'sittingClosedAt', 'status', 'tableNumber'])
    assert.deepEqual(tickets[0].items, [{ name: 'Classic Zinger', quantity: 1, instructions: 'No lettuce' }, { name: 'Classic Zinger', quantity: 2, instructions: 'Cut in half' }])
    assert.equal((await f.change(cashier, sent.reference, 'ready')).status, 409)
    const preparing = once(ownerSocket, 'customer:changed')
    const starts = await Promise.all([f.change(cashier, sent.reference, 'start'), f.change(cashier, sent.reference, 'start')])
    assert.deepEqual(starts.map(response => response.status), [204, 204])
    assert.deepEqual((await preparing)[0], { kind: 'preparing' })
    assert.equal((await f.change(cashier, sent.reference, 'serve')).status, 409)
    assert.equal((await f.change(cashier, sent.reference, 'ready')).status, 204)
    assert.equal((await f.change(cashier, sent.reference, 'start')).status, 409)
    assert.equal((await f.change(cashier, sent.reference, 'serve')).status, 204)
    assert.equal((await f.change(cashier, sent.reference, 'serve')).status, 204)
    assert.equal((await f.board(cashier)).tickets.length, 1)
    const history = db.prepare('SELECT status, approved_at, preparation_started_at, ready_at, served_at, total_minor FROM orders WHERE public_reference=?').get(sent.reference)
    assert.ok(history?.preparation_started_at && history.ready_at && history.served_at)
    assert.ok(String(history.approved_at) <= String(history.preparation_started_at) &&
      String(history.preparation_started_at) <= String(history.ready_at) && String(history.ready_at) <= String(history.served_at))
    assert.equal(history.status, 'served')
    assert.equal(history.total_minor, 165000)
    assert.equal((await f.overview(cashier)).sessions[0].confirmedTotalMinor, 330000)
    const disconnected = new Promise<void>(resolve => staffSocket.once('disconnect', () => resolve()))
    assert.equal((await f.api(staff + '/logout', cashier, {})).status, 204)
    await disconnected
    assert.equal((await f.api(kitchen, cashier)).status, 401)
    assert.deepEqual(leaks, [['customer:changed', 'submitted'], ['customer:changed', 'rejected']])
  } finally {
    for (const socket of connections) socket.disconnect()
    await f.close()
  }
})

test('v2 approved tickets survive migration, restart and settlement without entering the next sitting', { timeout: 15000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'urban-kitchen-'))
  const file = join(folder, 'legacy.sqlite')
  try {
    const old = new DatabaseSync(file)
    old.exec(schema)
    migrateOrders(old)
    migrateSessions(old)
    seedDemo(old)
    old.exec(`
      INSERT INTO table_sessions(table_id) VALUES (4);
      INSERT INTO browser_authorizations(session_id, token_hash) VALUES (1, 'legacy');
      INSERT INTO orders(table_id, session_id, authorization_id, status, total_minor, approved_at)
      VALUES (4, 1, 1, 'approved', 55000, CURRENT_TIMESTAMP);
      INSERT INTO order_items(order_id, menu_item_id, item_name, unit_price_minor, quantity, instructions)
      VALUES (1, 1, 'Historical item', 55000, 1, 'Legacy instruction');
    `)
    old.close()
    const db = openDatabase(file)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3)
    const f = await start(db)
    let cashier = ''
    try {
      cashier = await f.login()
      const before = (await f.board(cashier)).tickets[0]
      assert.equal(before.reference, 'legacy-1')
      assert.equal(before.items[0].name, 'Historical item')
      assert.equal(await (await f.change(cashier, before.reference, 'start')).status, 204)
      const customer = await f.customer()
      const accepted = await f.submit(customer)
      assert.equal((await f.decide(cashier, accepted.reference)).status, 204)
      const authorized = (await (await f.api(f.orders + '/session', customer)).json()).session
      assert.equal((await f.api(f.orders + '/bill', customer, { sessionKey: authorized.key })).status, 204)
      const sitting = (await f.overview(cashier)).sessions[0]
      assert.equal((await f.api(staff + '/sessions/' + sitting.id + '/settle', cashier, {
        billRevision: sitting.billRevision, confirmed: true, totalMinor: 220000,
      })).status, 204)
      assert.equal((await (await f.api(f.orders + '/session', customer)).json()).session, null)
      const newArrival = await f.customer()
      const order = await f.submit(newArrival)
      assert.equal((await f.decide(cashier, order.reference)).status, 204)
    } finally {
      await f.close()
    }
    const reopened = openDatabase(file)
    const restarted = await start(reopened)
    try {
      const tickets = (await restarted.board(cashier)).tickets
      assert.equal(tickets.length, 3)
      assert.equal(tickets[0].status, 'preparing')
      assert.ok(tickets[0].sittingClosedAt && tickets[0].preparationStartedAt)
      assert.equal(tickets[1].status, 'approved')
      assert.ok(tickets[1].sittingClosedAt)
      assert.equal(tickets[2].sittingClosedAt, null)
      assert.equal((await restarted.change(cashier, 'legacy-1', 'ready')).status, 204)
      assert.equal((await restarted.change(cashier, 'legacy-1', 'serve')).status, 204)
      const history = reopened.prepare('SELECT session_id, total_minor FROM orders WHERE id = 1').get()
      assert.equal(history?.session_id, 1)
      assert.equal(history?.total_minor, 55000)
    } finally {
      await restarted.close()
    }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
