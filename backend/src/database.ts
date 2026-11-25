import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'
import { schema } from './schema.ts'
import { migrateOrders } from './order-migration.ts'
import { migrateSessions } from './session-migration.ts'
import { migrateKitchen } from './kitchen-migration.ts'

export function openDatabase(path = config.databasePath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
    transaction(db, () => {
      db.exec(schema)
      migrateOrders(db)
      migrateSessions(db)
      migrateKitchen(db)
    })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
