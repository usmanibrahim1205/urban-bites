import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { io } from 'socket.io-client'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { seedDemo } from '../backend/src/seed.ts'
import { createTableQr } from '../backend/src/table-qr.ts'

test('schema, foreign keys, session uniqueness, and authorization validity', () => {
  const db = openDatabase(':memory:')
  try {
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
    assert.throws(() => db.exec('INSERT INTO table_sessions (table_id) VALUES (999)'), /FOREIGN KEY/)
    seedDemo(db)
    db.exec("INSERT INTO table_sessions (table_id) VALUES (1)")
    assert.throws(() => db.exec('INSERT INTO table_sessions (table_id) VALUES (1)'), /UNIQUE/)
    db.exec("INSERT INTO browser_authorizations (session_id, token_hash) VALUES (1, 'test-hash')")
    assert.throws(() => db.exec('INSERT INTO orders (table_id, session_id, total_minor) VALUES (1, 1, 55000)'), /CHECK/)
    assert.throws(() => db.exec('INSERT INTO orders (table_id, session_id, authorization_id, total_minor) VALUES (2, 1, 1, 55000)'), /FOREIGN KEY/)
    db.exec(`
      INSERT INTO orders (table_id, pending_browser_hash, total_minor) VALUES (1, 'pending-hash', 55000);
      INSERT INTO orders (table_id, session_id, authorization_id, total_minor) VALUES (1, 1, 1, 55000);
    `)
    assert.equal(db.prepare('SELECT session_id FROM orders WHERE id = 1').get()?.session_id, null)
    assert.throws(() => db.exec("UPDATE orders SET status = 'preparing' WHERE id = 2"), /CHECK/)
    assert.equal(db.prepare('SELECT count(*) AS count FROM active_browser_authorizations').get()?.count, 1)
    db.exec('UPDATE table_sessions SET closed_at = CURRENT_TIMESTAMP WHERE id = 1')
    db.exec('INSERT INTO table_sessions (table_id) VALUES (1)')
    assert.equal(db.prepare('SELECT count(*) AS count FROM active_browser_authorizations').get()?.count, 0)
    assert.equal(db.prepare('SELECT count(*) AS count FROM table_sessions').get()?.count, 2)
  } finally {
    db.close()
  }
})

test('idempotent seeding and file persistence across database and application restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qr-ordering-'))
  const path = join(dir, 'demo.sqlite')
  let db = openDatabase(path)
  try {
    seedDemo(db)
    const getTables = () => db.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all()
    const original = getTables()
    assert.deepEqual(original.map(table => table.number), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'])
    assert.equal(new Set(original.map(table => table.public_code)).size, 10)
    assert.throws(() => db.exec("UPDATE restaurant_tables SET public_code = 'ffffffffffffffffffffffffffffffff' WHERE id = 1"), /permanent/)
    db.exec("UPDATE menu_items SET available = 0 WHERE slug = 'classic-zinger'")
    db.exec('INSERT INTO table_sessions (table_id) VALUES (1)')
    seedDemo(db)
    const initialApp = createApplication(db)
    assert.deepEqual(await readTables(initialApp), original.map(({ number, public_code }) => ({ number, tableCode: public_code })))
    db.close()

    db = openDatabase(path)
    seedDemo(db)
    assert.deepEqual(getTables(), original)
    assert.equal(db.prepare('SELECT count(*) AS count FROM menu_items').get()?.count, 15)
    assert.equal(db.prepare('SELECT count(*) AS count FROM menu_categories').get()?.count, 5)
    assert.equal(db.prepare("SELECT available FROM menu_items WHERE slug = 'classic-zinger'").get()?.available, 0)
    assert.equal(db.prepare('SELECT count(*) AS count FROM table_sessions').get()?.count, 1)
    assert.deepEqual(await readTables(createApplication(db)), original.map(({ number, public_code }) => ({ number, tableCode: public_code })))
  } finally {
    if (db.isOpen) db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function listen(app: ReturnType<typeof createApplication>) {
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function readTables(app: ReturnType<typeof createApplication>) {
  const origin = await listen(app)
  try {
    const response = await fetch(origin + '/api/demo/tables')
    assert.equal(response.status, 200)
    return (await response.json()).tables
  } finally {
    await app.io.close()
  }
}

test('public API contract and real Socket.IO WebSocket connection', async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  const app = createApplication(db)
  const origin = await listen(app)
  const client = io(origin, { autoConnect: false, transports: ['websocket'], timeout: 3000, reconnection: false })
  try {
    const health = await fetch(origin + '/api/health')
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })
    const menuResponse = await fetch(origin + '/api/menu')
    assert.equal(menuResponse.status, 200)
    const menu = await menuResponse.json()
    assert.equal(menu.restaurant, 'Urban Bites')
    assert.equal(menu.currency, 'PKR')
    assert.deepEqual(menu.categories.map(category => category.name), ['Burgers', 'Pizza', 'Sides', 'Drinks', 'Desserts'])
    const menuItems = menu.categories.flatMap(category => category.items)
    assert.deepEqual(menuItems.map(item => [item.name, item.priceMinor]), [
      ['Classic Zinger', 55000], ['Double Zinger', 75000], ['Grilled Chicken Burger', 65000],
      ['Beef Smash Burger', 85000], ['Chicken Fajita', 125000], ['Chicken Tikka', 125000],
      ['Pepperoni', 145000], ['Regular Fries', 25000], ['Loaded Fries', 45000],
      ['Chicken Nuggets', 40000], ['Pepsi', 12000], ['7UP', 12000], ['Mineral Water', 8000],
      ['Chocolate Brownie', 35000], ['Chocolate Sundae', 30000],
    ])
    assert.ok(menuItems.every(item => item.description.length > 0 && item.available === true))
    assert.ok(menuItems.every(item => Object.keys(item).sort().join() === 'available,description,name,priceMinor,slug'))

    const { tables } = await (await fetch(origin + '/api/demo/tables')).json()
    for (const table of tables) {
      assert.deepEqual(Object.keys(table).sort(), ['number', 'tableCode'])
      const response = await fetch(origin + '/api/tables/' + table.tableCode)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { table })
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM table_sessions').get()?.count, 0)
    for (const [code, status, error] of [
      ['invalid', 400, 'INVALID_TABLE_CODE'],
      ['%ZZ', 400, 'INVALID_PATH'],
      ['0'.repeat(32), 404, 'TABLE_NOT_FOUND'],
    ] as const) {
      const response = await fetch(origin + '/api/tables/' + code)
      assert.equal(response.status, status)
      assert.equal((await response.json()).error.code, error)
    }
    assert.equal((await fetch(origin + '/api/orders', { method: 'POST' })).status, 404)
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('connect_error', reject)
      client.connect()
    })
    assert.equal(client.connected, true)
  } finally {
    client.disconnect()
    await app.io.close()
    db.close()
  }
})

test('generates a table QR SVG for the supplied origin and public code', async () => {
  const origin = new URL('http://192.168.1.10:5173')
  const svg = await createTableQr(origin, '1'.repeat(32))
  assert.match(svg, /^<svg/)
  assert.notEqual(svg, await createTableQr(origin, '2'.repeat(32)))
  assert.notEqual(svg, await createTableQr(new URL('http://192.168.1.20:5173'), '1'.repeat(32)))
})
