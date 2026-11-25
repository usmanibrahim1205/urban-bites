import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

const root = import.meta.dirname + '/../..'
const envFile = resolve(root, '.env')
if (existsSync(envFile)) loadEnvFile(envFile)

export function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(name + ' must be a port between 1 and 65535')
  }
  return value
}

export const config = {
  backendHost: process.env.BACKEND_HOST ?? '127.0.0.1',
  backendPort: port('BACKEND_PORT', 3001),
  databasePath: resolve(root, process.env.DATABASE_PATH ?? 'data/ordering.sqlite'),
  frontendDist: resolve(root, 'frontend/dist'),
  secureCookies: process.env.SECURE_COOKIES === 'true',
}
