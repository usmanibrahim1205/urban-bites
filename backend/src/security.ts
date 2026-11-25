import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { HttpError } from './http-error.ts'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function cookieValue(header: string | undefined, name: string) {
  const values = new Set(header?.split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '=')).map(part => part.slice(name.length + 1)))
  return values.size === 1 ? [...values][0] : undefined
}

export function sameOrigin(origin: string | undefined, host: string | undefined, site?: string) {
  return site !== 'cross-site' && (!origin || origin === 'http://' + host || origin === 'https://' + host)
}

export function requireSameOrigin(request: Request) {
  if (!sameOrigin(request.get('origin'), request.get('host'), request.get('sec-fetch-site'))) {
    throw new HttpError(403, 'INVALID_ORIGIN', 'Open this page directly and try again.')
  }
}
