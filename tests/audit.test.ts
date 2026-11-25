import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { io } from 'socket.io-client'
import { createServer } from 'vite'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { prepareDemoDatabase } from '../backend/src/demo-database.ts'
import { seedDemo } from '../backend/src/seed.ts'

test('Vite confines development file access to the frontend and dependencies', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(process.cwd(), '.vite-audit-'))
  const fixture = join(dir, 'sentinel.sqlite')
  await writeFile(fixture, 'disposable audit fixture')
  const vite = await createServer({
    configFile: 'frontend/vite.config.ts', server: { host: '127.0.0.1', strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = 'http://127.0.0.1:' + address.port
    const denied = await fetch(origin + '/@fs/' + fixture.replaceAll('\\', '/'))
    assert.equal(denied.status, 403)
    assert.doesNotMatch(await denied.text(), /disposable audit fixture/)
    assert.equal((await fetch(origin + '/src/main.tsx')).status, 200)
    assert.equal((await fetch(origin + '/menu-images/classic-zinger.jpg')).status, 200)
  } finally {
    await vite.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function start(db: ReturnType<typeof openDatabase>, credential: string) {
  const app = createApplication(db, undefined, credential)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const api = (path: string, options?: RequestInit) => fetch(origin + '/api/' + path, options)
  return { ...app, origin, api }
}

async function staffCookie(app: Awaited<ReturnType<typeof start>>, credential: string) {
  const response = await app.api('staff/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await response.text()
  return cookie
}

test('staff sessions survive normal restart, expire on an open socket and fail after credential rotation', { timeout: 15000 }, async () => {
  const db = openDatabase(':memory:')
  let app = await start(db, 'audit-fixture-old')
  try {
    const cookie = await staffCookie(app, 'audit-fixture-old')
    await app.io.close()
    app = await start(db, 'audit-fixture-old')
    assert.equal((await app.api('staff/session', { headers: { cookie } })).status, 200)
    db.prepare('UPDATE staff_sessions SET expires_at = ?').run(Date.now() + 2000)
    const socket = io(app.origin, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false })
    try {
      await once(socket, 'connect')
      assert.equal(app.io.sockets.adapter.rooms.get('staff:order-requests')?.size, 1)
      await once(socket, 'disconnect')
      assert.equal((await app.api('staff/kitchen', { headers: { cookie } })).status, 401)
    } finally { socket.disconnect() }
    const fresh = await staffCookie(app, 'audit-fixture-old')
    await app.io.close()
    app = await start(db, 'audit-fixture-new')
    assert.equal((await app.api('staff/tables', { headers: { cookie: fresh } })).status, 401)
    const stale = io(app.origin, { transports: ['websocket'], extraHeaders: { cookie: fresh }, reconnection: false, forceNew: true })
    try {
      await once(stale, 'connect')
      assert.equal(app.io.sockets.adapter.rooms.get('staff:order-requests'), undefined)
    } finally { stale.disconnect() }
    await staffCookie(app, 'audit-fixture-new')
  } finally {
    await app.io.close()
    db.close()
  }
})

test('browser origin, body limits and error responses preserve API boundaries', async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  const app = await start(db, 'audit-fixture')
  try {
    const code = db.prepare("SELECT public_code FROM restaurant_tables WHERE number='04'").get()?.public_code
    const path = 'tables/' + code + '/orders'
    const first = await app.api(path + '/latest')
    const cookie = first.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    assert.equal((await app.api(path + '/latest', { headers: { cookie, origin: 'https://other.example.test' } })).status, 403)
    const staff = await staffCookie(app, 'audit-fixture')
    assert.equal((await app.api('staff/logout', { method: 'POST', headers: { cookie: staff, origin: 'https://other.example.test' } })).status, 403)
    for (const [encoding, body, status] of [
      ['identity', 'x'.repeat(33000), 413], ['unsupported', '{}', 415], ['identity', '{', 400],
    ] as const) {
      const response = await app.api(path, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'content-encoding': encoding }, body,
      })
      assert.equal(response.status, status)
      assert.deepEqual(await response.json(), { error: { code: 'INVALID_BODY', message: 'The request could not be read.' } })
    }
    assert.equal((await app.api('staff/overview', { headers: { cookie: staff } })).status, 200)
    assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 0)
  } finally {
    await app.io.close()
    db.close()
  }
})

test('demo preparation copies only public identifiers, leaves the source intact and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'urban-demo-audit-'))
  const source = join(directory, 'source.sqlite')
  const target = join(directory, 'demo.sqlite')
  try {
    const db = openDatabase(source)
    seedDemo(db)
    db.exec(`
      INSERT INTO table_sessions (table_id) VALUES (4);
      INSERT INTO orders (table_id, total_minor) VALUES (4, 55000);
      INSERT INTO staff_sessions VALUES ('test-digest', 1);
    `)
    const tables = db.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all()
    const signer = db.prepare('SELECT secret FROM customer_identity_signing').get()?.secret
    db.close()
    const before = await readFile(source)
    prepareDemoDatabase(source, target)
    assert.throws(() => prepareDemoDatabase(source, target), { code: 'EEXIST' })
    assert.deepEqual(await readFile(source), before)
    const demo = openDatabase(target)
    try {
      assert.deepEqual(demo.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all(), tables)
      assert.equal(demo.prepare('SELECT count(*) AS count FROM menu_items').get()?.count, 15)
      for (const table of ['orders', 'table_sessions', 'browser_authorizations', 'staff_sessions']) {
        assert.equal(demo.prepare('SELECT count(*) AS count FROM ' + table).get()?.count, 0)
      }
      assert.notEqual(demo.prepare('SELECT secret FROM customer_identity_signing').get()?.secret, signer)
      assert.equal(demo.prepare('PRAGMA user_version').get()?.user_version, 3)
      assert.deepEqual(demo.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { demo.close() }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
