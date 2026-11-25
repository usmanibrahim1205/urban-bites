import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response } from 'express'
import { config } from './config.ts'
import { cookieValue, digest } from './security.ts'

const name = 'qr_browser'
const legacyPath = '/api/tables'

export function createBrowserIdentity(db: DatabaseSync) {
  const installation = Buffer.from(String(db.prepare('SELECT secret FROM customer_identity_signing WHERE id = 1').get()?.secret), 'hex')
  if (installation.length !== 32) throw new Error('Customer browser signing secret is missing.')
  let secret = installation
  if (config.render) {
    const configured = process.env.BROWSER_SIGNING_SECRET ?? ''
    if (!/^[A-Za-z0-9+/]{43}=$/.test(configured)) {
      throw new Error('Render requires BROWSER_SIGNING_SECRET as a base64-encoded 32-byte secret.')
    }
    secret = createHmac('sha256', Buffer.from(configured, 'base64')).update(installation).digest()
  }
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex')

  function validated(header: string | undefined) {
    const value = cookieValue(header, name)
    if (!value || !/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(value)) return undefined
    const [credential, signature] = value.split('.')
    if (timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(credential), 'hex'))) return value
  }

  return {
    hash(header: string | undefined) {
      const value = validated(header)
      return value ? digest(value.split('.')[0]) : undefined
    },
    issue(request: Request, response: Response) {
      const existing = validated(request.headers.cookie)
      const credential = randomBytes(32).toString('hex')
      const options = { httpOnly: true, sameSite: 'lax' as const, secure: config.secureCookies || request.secure }
      response.cookie(name, existing ?? credential + '.' + sign(credential), {
        ...options, path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
      })
      if (request.headers.cookie?.includes(name + '=')) response.clearCookie(name, { ...options, path: legacyPath })
    },
  }
}

export type BrowserIdentity = ReturnType<typeof createBrowserIdentity>
