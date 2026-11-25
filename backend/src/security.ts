import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { HttpError } from './http-error.ts'
import { config } from './config.ts'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function cookieValue(header: string | undefined, name: string) {
  const values = new Set(header?.split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '=')).map(part => part.slice(name.length + 1)))
  return values.size === 1 ? [...values][0] : undefined
}

export function sameOrigin(origin: string | undefined, host: string | undefined, site?: string) {
  if (site === 'cross-site') return false
  if (config.render) return origin === undefined || origin === config.publicOrigin
  return !origin || origin === 'http://' + host || origin === 'https://' + host
}

export function requireSameOrigin(request: Request) {
  const origin = request.get('origin')
  const originRequired = config.render && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  if ((originRequired && !origin) || !sameOrigin(origin, request.get('host'), request.get('sec-fetch-site'))) {
    throw new HttpError(403, 'INVALID_ORIGIN', 'Open this page directly and try again.')
  }
}
