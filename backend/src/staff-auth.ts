import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { RequestHandler } from 'express'
import { config } from './config.ts'
import { HttpError } from './http-error.ts'
import { cookieValue, digest, requireSameOrigin } from './security.ts'
import { restaurant } from './restaurant.ts'

const name = 'qr_staff'
const lifetime = 8 * 60 * 60 * 1000
const sessionDigest = (key: Buffer, token: string) => createHmac('sha256', key).update(token).digest('hex')

export function createStaffAuth(db: DatabaseSync, credential: string | undefined, revokeSocket: (hash: string) => void) {
  const configured = credential ? Buffer.from(digest(credential), 'hex') : null
  const lookup = db.prepare('SELECT expires_at FROM staff_sessions WHERE credential_hash = ? AND expires_at > ?')
  const insert = db.prepare('INSERT INTO staff_sessions VALUES (?, ?)')
  const remove = db.prepare('DELETE FROM staff_sessions WHERE credential_hash = ?')
  const purge = db.prepare('DELETE FROM staff_sessions WHERE expires_at <= ?')
  const attempts = new Map<string, { failures: number; until: number }>()

  function authenticate(header: string | undefined) {
    if (!configured) return undefined
    const value = cookieValue(header, name)
    if (!value || !/^[0-9a-f]{64}$/.test(value)) return undefined
    const hash = sessionDigest(configured, value)
    const row = lookup.get(hash, Date.now())
    if (row) return { hash, expiresAt: Number(row.expires_at) }
  }

  const requireStaff: RequestHandler = (request, _response, next) => {
    if (!authenticate(request.headers.cookie)) throw new HttpError(401, 'STAFF_REQUIRED', 'Sign in to continue.')
    next()
  }

  const router = express.Router()
  router.use((request, response, next) => {
    response.set('Cache-Control', 'private, no-store')
    requireSameOrigin(request)
    next()
  })
  router.get('/session', requireStaff, (_request, response) => {
    response.json({ restaurant: restaurant.name })
  })
  router.post('/login', express.json({ limit: '2kb' }), (request, response) => {
    if (!configured) throw new HttpError(503, 'STAFF_UNCONFIGURED', 'Staff sign-in needs to be configured on this server.')
    const now = Date.now()
    const ip = request.socket.remoteAddress ?? 'unknown'
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key)
    const attempt = attempts.get(ip)
    if (attempt && attempt.failures >= 5) {
      response.set('Retry-After', String(Math.ceil((attempt.until - now) / 1000)))
      throw new HttpError(429, 'LOGIN_LIMIT', 'Too many attempts. Try again in a few minutes.')
    }
    const password: unknown = request.body?.credential
    if (typeof password !== 'string' || password.length > 512 || !timingSafeEqual(configured, Buffer.from(digest(password), 'hex'))) {
      attempts.set(ip, { failures: (attempt?.failures ?? 0) + 1, until: attempt?.until ?? now + 5 * 60_000 })
      throw new HttpError(401, 'BAD_CREDENTIAL', 'The staff password is incorrect.')
    }
    attempts.delete(ip)
    const previous = authenticate(request.headers.cookie)
    if (previous) {
      remove.run(previous.hash)
      revokeSocket(previous.hash)
    }
    purge.run(now)
    const token = randomBytes(32).toString('hex')
    insert.run(sessionDigest(configured, token), now + lifetime)
    response.cookie(name, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies || request.secure, maxAge: lifetime,
    })
    response.json({ restaurant: restaurant.name })
  })
  router.post('/logout', requireStaff, (request, response) => {
    const session = authenticate(request.headers.cookie)
    if (session) {
      remove.run(session.hash)
      revokeSocket(session.hash)
    }
    response.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies || request.secure })
    response.sendStatus(204)
  })
  return { router, requireStaff, authenticate }
}

export type StaffAuth = ReturnType<typeof createStaffAuth>
