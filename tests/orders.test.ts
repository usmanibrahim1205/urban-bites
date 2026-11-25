import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { io } from 'socket.io-client'
import { createServer as createVite } from 'vite'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { schema } from '../backend/src/schema.ts'
import { seedDemo } from '../backend/src/seed.ts'

const randomKey = () => randomBytes(16).toString('hex')
const draft = () => ({
  idempotencyKey: randomKey(),
  items: [{ slug: 'classic-zinger', quantity: 2, instructions: ' No lettuce ' }],
})

async function start(db: DatabaseSync) {
  const app = createApplication(db)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  return { ...app, origin: `http://127.0.0.1:${address.port}` }
}

async function fixture(path = ':memory:') {
  const db = openDatabase(path)
  seedDemo(db)
  const { origin, io: serverSocket } = await start(db)
  const code = String(db.prepare("SELECT public_code FROM restaurant_tables WHERE number = '01'").get()?.public_code)
  const ordersUrl = (tableCode = code) => origin + '/api/tables/' + tableCode + '/orders'
  const latest = (cookie?: string, tableCode = code) => fetch(ordersUrl(tableCode) + '/latest', {
    headers: cookie ? { cookie } : {},
  })
  const post = (body: unknown, cookie?: string, tableCode = code, headers?: Record<string, string>) => fetch(ordersUrl(tableCode), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  })
  const close = async () => { await serverSocket.close(); db.close() }
  const count = (table: 'orders' | 'order_items' | 'table_sessions' | 'browser_authorizations') =>
    Number(db.prepare('SELECT count(*) AS total FROM ' + table).get()?.total)
  return { db, origin, code, latest, post, close, count, serverSocket }
}

async function identity(latest: () => Promise<Response>) {
  const response = await latest()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const header = response.headers.get('set-cookie')
  assert.ok(header?.includes('HttpOnly') && header.includes('SameSite=Lax'))
  assert.deepEqual(await response.json(), { order: null })
  return header.split(';')[0]
}

test('v0 data is migrated once and historical rows keep their values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ordering-migration-'))
  const path = join(dir, 'old.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(schema)
    seedDemo(old)
    const before = old.prepare('SELECT public_code FROM restaurant_tables ORDER BY id').all()
    old.exec(`
      INSERT INTO orders (table_id, total_minor) VALUES (1, 55000);
      INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_minor, quantity)
      VALUES (1, 1, 'Historical name', 55000, 1);
    `)
    old.close()
    for (let run = 0; run < 2; run++) {
      const migrated = openDatabase(path)
      try {
        assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3)
        assert.deepEqual(migrated.prepare('SELECT public_code FROM restaurant_tables ORDER BY id').all(), before)
        assert.equal(migrated.prepare('SELECT item_name FROM order_items').get()?.item_name, 'Historical name')
        assert.equal(migrated.prepare('SELECT instructions FROM order_items').get()?.instructions, '')
        assert.equal(migrated.prepare('SELECT public_reference FROM orders').get()?.public_reference, null)
      } finally {
        migrated.close()
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists authoritative item snapshots and keeps initial orders separate from sessions and browsers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ordering-phase-two-'))
  const path = join(dir, 'orders.sqlite')
  const setup = await fixture(path)
  let cookie = ''
  let saved: { reference: string; idempotencyKey: string }
  try {
    const scan = await fetch(setup.origin + '/api/tables/' + setup.code)
    assert.equal(scan.status, 200)
    assert.equal(setup.count('table_sessions'), 0)
    cookie = await identity(setup.latest)
    assert.equal(setup.count('table_sessions'), 0)
    const payload = draft()
    const response = await setup.post({
      ...payload, status: 'approved', totalMinor: 1, authorizationId: 1, sessionId: 1,
      items: [{ ...payload.items[0], priceMinor: 1 }],
    }, cookie)
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const { order } = await response.json()
    saved = order
    assert.deepEqual(Object.keys(order).sort(), ['currency', 'idempotencyKey', 'items', 'reference', 'status', 'tableNumber', 'totalMinor'])
    assert.match(order.reference, /^[0-9A-F]{16}$/)
    assert.equal(order.status, 'pending')
    assert.equal(order.tableNumber, '01')
    assert.equal(order.totalMinor, 110000)
    assert.deepEqual(order.items, [{ name: 'Classic Zinger', unitPriceMinor: 55000, quantity: 2, instructions: 'No lettuce' }])
    assert.equal(setup.count('table_sessions'), 0)
    assert.equal(setup.count('browser_authorizations'), 0)
    assert.equal(setup.count('order_items'), 1)
    assert.equal(setup.db.prepare('SELECT length(pending_browser_hash) AS width FROM orders').get()?.width, 64)
    assert.ok(!(JSON.stringify(order).includes(cookie)))

    setup.db.exec('INSERT INTO table_sessions (table_id) VALUES (1)')
    const second = await setup.post(draft(), cookie)
    assert.equal(second.status, 201)
    assert.equal(setup.db.prepare('SELECT count(*) AS total FROM orders WHERE session_id IS NOT NULL OR authorization_id IS NOT NULL OR approved_at IS NOT NULL').get()?.total, 0)
    assert.equal(setup.count('table_sessions'), 1)
    assert.equal(setup.count('browser_authorizations'), 0)
    assert.deepEqual(await (await setup.latest(await identity(setup.latest))).json(), { order: null })
    assert.deepEqual(await (await setup.latest(cookie, String(setup.db.prepare("SELECT public_code FROM restaurant_tables WHERE number='02'").get()?.public_code))).json(), { order: null })
    const guessed = await fetch(setup.origin + '/api/tables/' + setup.code + '/orders/' + saved.reference)
    assert.equal(guessed.status, 404)
    saved = (await second.json()).order
  } finally {
    await setup.close()
  }

  try {
    const restarted = await fixture(path)
    try {
      const { order } = await (await restarted.latest(cookie)).json()
      assert.equal(order.reference, saved.reference)
      assert.equal(order.idempotencyKey, saved.idempotencyKey)
      assert.equal(restarted.count('orders'), 2)
      assert.equal(restarted.count('order_items'), 2)
    } finally {
      await restarted.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validates orders, rejects forged cookies and rolls back on line insert failure', async () => {
  const setup = await fixture()
  try {
    const cookie = await identity(setup.latest)
    assert.equal((await setup.post(draft())).status, 401)
    assert.equal((await setup.post(draft(), 'qr_browser=' + 'a'.repeat(64) + '.' + 'a'.repeat(64))).status, 401)
    assert.equal((await setup.post(draft(), cookie, 'bad')).status, 400)
    assert.equal((await setup.post(draft(), cookie, '0'.repeat(32))).status, 404)
    assert.equal((await setup.post(draft(), cookie, setup.code, { origin: 'https://example.invalid' })).status, 403)
    assert.equal((await setup.post(draft(), cookie, setup.code, { 'content-type': 'text/plain' })).status, 415)
    const badJson = await fetch(setup.origin + '/api/tables/' + setup.code + '/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{',
    })
    assert.equal(badJson.status, 400)

    setup.db.exec("UPDATE menu_items SET available = 0 WHERE slug = 'pepsi'")
    for (const [override, status] of [
      [{ slug: 'unknown-item' }, 422], [{ slug: 'pepsi' }, 422], [{ quantity: 0 }, 400],
      [{ quantity: 21 }, 400], [{ quantity: 1.5 }, 400], [{ quantity: '2' }, 400],
      [{ instructions: 'a'.repeat(241) }, 400], [{ instructions: 'bad\0note' }, 400],
    ] as const) {
      const invalid = draft()
      assert.equal((await setup.post({ ...invalid, items: [{ ...invalid.items[0], ...override }] }, cookie)).status, status)
    }
    assert.equal(setup.count('orders'), 0)

    setup.db.exec(`
      CREATE TRIGGER fail_test_line BEFORE INSERT ON order_items
      WHEN NEW.quantity = 3
      BEGIN SELECT RAISE(ABORT, 'test line insert failed'); END;
    `)
    const failed = draft()
    const response = await setup.post({ ...failed, items: [...failed.items, { slug: 'pepperoni', quantity: 3 }] }, cookie)
    assert.equal(response.status, 500)
    assert.equal(setup.count('orders'), 0)
    assert.equal(setup.count('order_items'), 0)
    assert.equal((await setup.post(failed, cookie)).status, 201)
  } finally {
    await setup.close()
  }
})

test('concurrent retries store one order, emit once to the staff room and respect browser and table limits', async () => {
  const setup = await fixture()
  const publicSocket = io(setup.origin, { transports: ['websocket'], reconnection: false })
  try {
    await once(publicSocket, 'connect')
    const staffEvents: unknown[] = []
    const publicEvents: string[] = []
    publicSocket.onAny(event => publicEvents.push(event))
    const adapter = setup.serverSocket.of('/').adapter
    const broadcast = adapter.broadcast.bind(adapter)
    adapter.broadcast = (packet, options) => {
      if (packet.data[0] === 'order:requested') {
        assert.deepEqual([...options.rooms], ['staff:order-requests'])
        staffEvents.push(packet.data[1])
      }
      broadcast(packet, options)
    }

    const cookie = await identity(setup.latest)
    const order = draft()
    const responses = await Promise.all([setup.post(order, cookie), setup.post(order, cookie)])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201])
    const [a, b] = await Promise.all(responses.map(response => response.json()))
    assert.deepEqual(a, b)
    assert.equal(setup.count('orders'), 1)
    assert.deepEqual(staffEvents, [{ reference: a.order.reference, tableNumber: '01', status: 'pending' }])
    const conflict = await setup.post({ ...order, items: [{ ...order.items[0], quantity: 1 }] }, cookie)
    assert.equal(conflict.status, 409)

    for (let index = 0; index < 5; index++) assert.equal((await setup.post(draft(), cookie)).status, 201)
    assert.equal((await setup.post(draft(), cookie)).status, 429)
    assert.equal((await setup.post(order, cookie)).status, 200)
    for (let browser = 0; browser < 4; browser++) {
      const newCookie = await identity(setup.latest)
      for (let index = 0; index < 6; index++) assert.equal((await setup.post(draft(), newCookie)).status, 201)
    }
    const lastCookie = await identity(setup.latest)
    const tableLimit = await setup.post(draft(), lastCookie)
    assert.equal(tableLimit.status, 429)
    assert.equal(tableLimit.headers.get('retry-after'), '600')
    assert.equal(setup.count('orders'), 30)
    assert.equal(staffEvents.length, 30)
    assert.deepEqual(publicEvents, [])
  } finally {
    publicSocket.disconnect()
    await setup.close()
  }
})

test('Vite preserves the same-origin Host header for development submissions', async () => {
  const setup = await fixture()
  const previousPort = process.env.BACKEND_PORT
  process.env.BACKEND_PORT = new URL(setup.origin).port
  let vite: Awaited<ReturnType<typeof createVite>> | undefined
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
    const path = origin + '/api/tables/' + setup.code + '/orders'
    const cookie = await identity(() => fetch(path + '/latest'))
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify(draft()),
    })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).order.status, 'pending')
  } finally {
    if (previousPort === undefined) delete process.env.BACKEND_PORT
    else process.env.BACKEND_PORT = previousPort
    await vite?.close()
    await setup.close()
  }
})
