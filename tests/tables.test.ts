import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { createApplication } from '../backend/src/app.ts'
import { openDatabase } from '../backend/src/database.ts'
import { seedDemo } from '../backend/src/seed.ts'
import { parseQrOrigin, qrOriginSettings } from '../backend/src/table-qr.ts'

test('the QR origin accepts normalized LAN and HTTPS addresses and rejects inappropriate input', () => {
  assert.deepEqual(qrOriginSettings(parseQrOrigin('http://localhost:5173///')), { baseUrl: 'http://localhost:5173', loopback: true })
  assert.equal(qrOriginSettings(parseQrOrigin('http://127.1:5173')).loopback, true)
  assert.equal(qrOriginSettings(parseQrOrigin('http://[::1]:5173')).loopback, true)
  assert.equal(qrOriginSettings(parseQrOrigin('https://orders.example.test')).loopback, false)
  for (const value of ['bad', 'ftp://example.test', '//example.test', 'http://user:pw@example.test', 'http://@example.test',
    'https://example.test/path', 'http://example.test/.', 'https://example.test/?', 'https://example.test/#',
    'https://example.test/?secret=1', 'https://example.test\\foo', 'http://0.0.0.0', 'http://[::]', 'http://host:0', {}]) {
    assert.throws(() => parseQrOrigin(value))
  }
})

test('staff table data is live-derived and all ten QR PNGs independently decode to stable table links', { timeout: 15000 }, async () => {
  const db = openDatabase(':memory:')
  seedDemo(db)
  const app = createApplication(db, undefined, 'table-fixture')
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const root = '/api/staff/tables'
  const fetchApi = (url: string, cookie?: string, body?: object) => fetch(origin + url, {
    method: body ? 'POST' : 'GET', headers: { ...(cookie ? { cookie } : {}),
      ...(body ? { origin, 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  const qr = (number: string, baseUrl: string, format = 'png') => root + '/' + number + '/qr/' + format + '?' + new URLSearchParams({ baseUrl })
  const cookieFrom = (response: Response) => {
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return cookie
  }
  try {
    const before = db.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all()
    const base = 'http://192.168.1.10:5173'
    for (const path of [root, qr('04', base)]) assert.equal((await fetchApi(path)).status, 401)
    assert.equal((await fetchApi(root + '/qr-base', undefined, { baseUrl: base })).status, 401)
    const staff = cookieFrom(await fetchApi('/api/staff/login', undefined, { credential: 'table-fixture' }))
    const overview = async () => (await (await fetchApi(root, staff)).json()).tables
    const initial = await overview()
    assert.equal(initial.length, 10)
    assert.deepEqual(initial.map(table => table.state), Array(10).fill('available'))
    const payloads = new Set<string>()
    for (const table of initial) {
      const image = await fetchApi(qr(table.number, base), staff)
      assert.equal(image.headers.get('content-type'), 'image/png')
      const png = PNG.sync.read(Buffer.from(await image.arrayBuffer()))
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
      assert.equal(decoded?.data, base + '/menu/' + table.tableCode)
      payloads.add(decoded.data)
    }
    assert.equal(payloads.size, 10)
    const changed = await fetchApi(qr('04', 'https://orders.example.test//'), staff)
    const png = PNG.sync.read(Buffer.from(await changed.arrayBuffer()))
    assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data,
      'https://orders.example.test/menu/' + initial[3].tableCode)
    const svg = await fetchApi(qr('04', base, 'svg') + '&download=1', staff)
    assert.match(svg.headers.get('content-type') ?? '', /^image\/svg\+xml/)
    assert.match(svg.headers.get('content-disposition') ?? '', /table-04\.svg/)
    assert.match(await svg.text(), /<svg/)
    assert.equal((await fetchApi(qr('04', 'https://user:secret@orders.example.test'), staff)).status, 400)
    assert.equal((await fetchApi(qr('99', base), staff)).status, 404)
    assert.equal((await fetchApi(root + '/04/close', staff, {})).status, 404)

    const submitPath = '/api/tables/' + initial[3].tableCode + '/orders'
    const customer = cookieFrom(await fetchApi(submitPath + '/latest'))
    assert.equal((await fetchApi(root, customer)).status, 401)
    assert.equal(db.prepare('SELECT count(*) AS count FROM table_sessions').get()?.count, 0)
    assert.equal(db.prepare('SELECT count(*) AS count FROM browser_authorizations').get()?.count, 0)
    const submission = await fetchApi(submitPath, customer, {
      idempotencyKey: randomBytes(16).toString('hex'), items: [{ slug: 'classic-zinger', quantity: 2 }],
    })
    assert.equal(submission.status, 201)
    const pending = (await overview())[3]
    assert.equal(pending.state, 'awaiting-verification')
    assert.equal(pending.pendingCount, 1)
    assert.equal(pending.pendingTotalMinor, 110000)
    assert.equal(pending.sitting, null)
    const staffView = await (await fetchApi('/api/staff/overview', staff)).json()
    const order = staffView.orders[0]
    assert.equal((await fetchApi('/api/staff/orders/' + order.reference + '/approve', staff, {
      verified: false, reviewKey: order.reviewKey,
    })).status, 400)
    assert.equal((await fetchApi('/api/staff/orders/' + order.reference + '/approve', staff, {
      verified: true, reviewKey: order.reviewKey,
    })).status, 204)
    const occupied = (await overview())[3]
    assert.equal(occupied.state, 'occupied')
    assert.equal(occupied.pendingCount, 0)
    assert.equal(occupied.sitting.confirmedTotalMinor, 110000)
    assert.equal(occupied.sitting.authorizedBrowserCount, 1)
    assert.deepEqual(occupied.sitting.orders, [{ reference: order.reference, status: 'approved' }])
    assert.deepEqual(await (await fetchApi(submitPath + '/session')).json(), { session: null })
    assert.deepEqual(db.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all(), before)
  } finally {
    await app.io.close()
    db.close()
  }
})
