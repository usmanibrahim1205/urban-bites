import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, transaction } from './database.ts'
import { seedDemo } from './seed.ts'

export function prepareDemoDatabase(source: string, destination: string) {
  const original = new DatabaseSync(source, { readOnly: true })
  let tables
  try {
    tables = original.prepare('SELECT number, public_code FROM restaurant_tables ORDER BY number').all()
  } finally {
    original.close()
  }

  const valid = tables.length === 10 && tables.every((table, index) =>
    table.number === String(index + 1).padStart(2, '0') &&
    typeof table.public_code === 'string' && /^[0-9a-f]{32}$/.test(table.public_code),
  ) && new Set(tables.map(table => table.public_code)).size === 10
  if (!valid) throw new Error('The source must contain the ten unique permanent table identifiers.')

  mkdirSync(dirname(destination), { recursive: true })
  closeSync(openSync(destination, 'wx', 0o600))
  try {
    const demo = openDatabase(destination)
    try {
      const add = demo.prepare('INSERT INTO restaurant_tables (number, public_code) VALUES (?, ?)')
      transaction(demo, () => {
        for (const table of tables) add.run(table.number, table.public_code)
      })
      seedDemo(demo)
    } finally {
      demo.close()
    }
  } catch (error) {
    rmSync(destination)
    throw error
  }
}

if (import.meta.main) {
  const [source = 'data/ordering.sqlite', destination = 'data/demo.sqlite'] = process.argv.slice(2)
  try {
    prepareDemoDatabase(resolve(source), resolve(destination))
    console.log('Clean demonstration database created at ' + resolve(destination))
  } catch (error) {
    console.error((error as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'The destination already exists. Choose a new filename to preserve it.'
      : error instanceof Error ? error.message : 'Could not prepare the demonstration database.')
    process.exitCode = 1
  }
}
