import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { io } from 'socket.io-client'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { renderTableIdentifiers } from '../backend/src/render-table-identifiers.ts'

const hosted = 'https://urban-bites-fixture.onrender.com'
const credential = randomBytes(5).toString('hex')
const signingSecret = randomBytes(32).toString('base64')

async function start(directory: string) {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['backend/dist/server.js'], {
    env: { ...process.env, NODE_ENV: 'production', RENDER: 'true', PORT: String(address.port),
      RENDER_EXTERNAL_URL: hosted, STAFF_CREDENTIAL: credential, BROWSER_SIGNING_SECRET: signingSecret,
      TMPDIR: directory, TMP: directory, TEMP: directory,
      DATABASE_PATH: 'ignored-local-setting.sqlite', BACKEND_HOST: '127.0.0.1', SECURE_COOKIES: 'false',
      QR_BASE_URL: 'http://localhost:5173',
    },
    stdio: 'ignore', windowsHide: true,
  })
  const closed = once(child, 'exit')
  const origin = 'http://127.0.0.1:' + address.port
  const api = (path: string, options?: RequestInit) => fetch(origin + path, { signal: AbortSignal.timeout(4000), ...options })
  async function stop() { child.kill(); await closed }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await api('/api/health').catch(() => undefined)
      if (response?.ok) {
        assert.deepEqual(await response.json(), { status: 'ok' })
        return { origin, api, stop }
      }
      if (child.exitCode !== null) break
      await sleep(50)
    }
    throw new Error('Render-mode production child did not become healthy.')
  } catch (error) {
    await stop()
    throw error
  }
}

function cookie(response: Response, sameSite: 'Lax' | 'Strict') {
  const header = response.headers.get('set-cookie') ?? ''
  assert.match(header, /; Secure\b/)
  assert.match(header, /; HttpOnly\b/)
  assert.ok(header.includes('SameSite=' + sameSite))
  return header.split(';')[0]
}

function rows(directory: string) {
  const db = new DatabaseSync(join(directory, 'urban-bites', 'ordering.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const tables = db.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all()
    assert.deepEqual(tables.map(row => [row.number, row.public_code]), [...renderTableIdentifiers])
    assert.equal(db.prepare('SELECT count(*) AS n FROM menu_items').get()?.n, 15)
    return db.prepare('SELECT status, total_minor, approved_at FROM orders ORDER BY id').all()
  } finally { db.close() }
}

test('compiled Render-mode startup, HTTPS proxy security, workflow, and loss of ephemeral state', { timeout: 30000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'urban-bites-render-'))
  const first = join(folder, 'first')
  const fresh = join(folder, 'fresh')
  await Promise.all([mkdir(first), mkdir(fresh)])
  const table = renderTableIdentifiers.get('04')
  const path = '/api/tables/' + table + '/orders'
  let server: Awaited<ReturnType<typeof start>> | undefined
  try {
    server = await start(first)
    assert.deepEqual(rows(first), [])
    for (const route of ['/', '/cashier', '/kitchen', '/tables', '/menu/' + table]) {
      const response = await server.api(route)
      assert.equal(response.status, 200)
      assert.match(await response.text(), /id="root"/)
    }
    assert.equal((await server.api('/api/menu')).status, 200)
    assert.equal((await server.api('/api/staff/overview')).status, 401)
    assert.equal((await server.api('/.env')).status, 404)
    assert.equal((await server.api('/data/ordering.sqlite')).status, 404)

    function post(url: string, data: object, token?: string, origin: string | null = hosted) {
      assert.ok(server)
      return server.api(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https',
          ...(origin ? { origin } : {}), ...(token ? { cookie: token } : {}) }, body: JSON.stringify(data),
      })
    }
    const login = '/api/staff/login'
    assert.equal((await post(login, { credential }, undefined, null)).status, 403)
    assert.equal((await post(login, { credential }, undefined, 'https://foreign.example.test')).status, 403)
    const signed = await post(login, { credential })
    assert.equal(signed.status, 200)
    const staff = cookie(signed, 'Strict')
    const customer = cookie(await server.api(path + '/latest'), 'Lax')
    const headers = { cookie: staff }
    const board = '/api/staff/kitchen'
    const snapshot = (await (await server.api('/api/staff/tables', { headers })).json()).defaultBase
    assert.deepEqual(snapshot, { baseUrl: hosted, loopback: false })
    const qr = await server.api('/api/staff/tables/04/qr/png?' + new URLSearchParams({ baseUrl: hosted }), { headers })
    const png = PNG.sync.read(Buffer.from(await qr.arrayBuffer()))
    assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, hosted + '/menu/' + table)

    const badSocket = io(server.origin, { forceNew: true, transports: ['websocket'], reconnection: false,
      timeout: 2500, extraHeaders: { origin: 'https://foreign.example.test', cookie: staff } })
    try {
      await new Promise<void>((resolve, reject) => {
        badSocket.once('connect', () => reject(new Error('Foreign-origin socket connected')))
        badSocket.once('connect_error', () => resolve())
      })
    } finally { badSocket.disconnect() }

    const socket = io(server.origin, { forceNew: true, transports: ['polling', 'websocket'], reconnection: false,
      timeout: 2500, extraHeaders: { origin: hosted, cookie: staff } })
    const customerSocket = io(server.origin + '/customer', { forceNew: true, transports: ['websocket'], reconnection: false,
      timeout: 2500, extraHeaders: { origin: hosted, cookie: customer } })
    try {
      await Promise.all([socket, customerSocket].map(client => new Promise<void>((resolve, reject) => {
        client.once('connect', resolve)
        client.once('connect_error', error => reject(new Error('Render-mode socket could not connect: ' + error.message)))
      })))
      if (socket.io.engine.transport.name !== 'websocket') {
        await once(socket.io.engine, 'upgrade', { signal: AbortSignal.timeout(2500) })
          .catch(() => { throw new Error('Render-mode staff socket did not upgrade from polling') })
      }
      assert.equal(socket.io.engine.transport.name, 'websocket')
      const queued = once(socket, 'order:requested', { signal: AbortSignal.timeout(4000) })
      const draft = { idempotencyKey: randomBytes(16).toString('hex'), items: [{ slug: 'classic-zinger', quantity: 2 }] }
      const result = await post(path, draft, customer)
      assert.equal(result.status, 201)
      const { order } = await result.json()
      assert.equal((await queued)[0].reference, order.reference)
      assert.deepEqual((await (await server.api(board, { headers })).json()).tickets, [])
      const pending = (await (await server.api('/api/staff/overview', { headers })).json()).orders[0]
      assert.equal((await post('/api/staff/orders/' + order.reference + '/approve',
        { reviewKey: pending.reviewKey, verified: true }, staff)).status, 204)
      for (const step of ['start', 'ready', 'serve']) {
        assert.equal((await post(board + '/orders/' + order.reference + '/' + step, {}, staff)).status, 204)
      }
      const session = (await (await server.api(path + '/session', { headers: { cookie: customer } })).json()).session
      assert.equal(session.confirmedTotalMinor, 110000)
      assert.equal((await post(path + '/bill', { sessionKey: session.key }, customer)).status, 204)
      const occupied = (await (await server.api('/api/staff/overview', { headers })).json()).sessions[0]
      assert.equal((await post('/api/staff/sessions/' + occupied.id + '/settle',
        { billRevision: occupied.billRevision, totalMinor: 110000, confirmed: true }, staff)).status, 204)
      assert.equal(rows(first)[0].status, 'served')
      assert.equal(rows(first)[0].total_minor, 110000)
    } finally { socket.disconnect(); customerSocket.disconnect() }

    await server.stop()
    server = await start(first)
    assert.equal(rows(first).length, 1)
    assert.equal((await server.api('/api/staff/overview', { headers })).status, 200)
    await server.stop()
    server = await start(fresh)
    assert.deepEqual(rows(fresh), [])
    assert.equal((await server.api('/api/staff/overview', { headers })).status, 401)
    const prior = await server.api(path + '/latest', { headers: { cookie: customer } })
    assert.deepEqual(await prior.json(), { order: null })
    assert.notEqual(cookie(prior, 'Lax'), customer)
    assert.equal((await post(path, { idempotencyKey: randomBytes(16).toString('hex'), items: [{ slug: 'pepsi', quantity: 1 }] }, customer)).status, 401)
  } finally {
    await server?.stop()
    await rm(folder, { recursive: true, force: true })
  }
})
