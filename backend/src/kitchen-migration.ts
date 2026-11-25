import type { DatabaseSync } from 'node:sqlite'

export function migrateKitchen(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 3) return
  db.exec(`
    ALTER TABLE orders ADD COLUMN preparation_started_at TEXT;
    ALTER TABLE orders ADD COLUMN ready_at TEXT;
    ALTER TABLE orders ADD COLUMN served_at TEXT;
    ALTER TABLE orders ADD COLUMN is_additional INTEGER CHECK (is_additional IN (0, 1));
    CREATE INDEX kitchen_active_approval ON orders(approved_at, id)
      WHERE status IN ('approved', 'preparing', 'ready');
    PRAGMA user_version = 3;
  `)
}
