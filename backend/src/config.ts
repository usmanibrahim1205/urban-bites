import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { loadEnvFile } from 'node:process'

const root = import.meta.dirname + '/../..'
const envFile = resolve(root, '.env')
if (process.env.RENDER !== 'true' && existsSync(envFile)) loadEnvFile(envFile)
const render = process.env.RENDER === 'true'

export function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(name + ' must be a port between 1 and 65535')
  }
  return value
}

export const config = {
  render,
  publicOrigin: render ? process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '') : undefined,
  backendHost: render ? '0.0.0.0' : process.env.BACKEND_HOST ?? '127.0.0.1',
  backendPort: render ? port('PORT', 10000) : port('BACKEND_PORT', 3001),
  databasePath: render ? resolve(tmpdir(), 'urban-bites', 'ordering.sqlite') : resolve(root, process.env.DATABASE_PATH ?? 'data/ordering.sqlite'),
  frontendDist: resolve(root, 'frontend/dist'),
  secureCookies: render || process.env.SECURE_COOKIES === 'true',
}
