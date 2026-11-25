import type { DatabaseSync } from 'node:sqlite'

export function migrateOrders(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 1) return
  db.exec(`
    ALTER TABLE orders ADD COLUMN public_reference TEXT;
    ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
    ALTER TABLE orders ADD COLUMN request_hash TEXT;
    ALTER TABLE order_items ADD COLUMN instructions TEXT NOT NULL DEFAULT ''
      CHECK (length(instructions) <= 240);
    CREATE UNIQUE INDEX order_public_reference ON orders(public_reference)
      WHERE public_reference IS NOT NULL;
    CREATE UNIQUE INDEX order_browser_idempotency ON orders(pending_browser_hash, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX order_browser_history ON orders(pending_browser_hash, table_id, id DESC)
      WHERE public_reference IS NOT NULL;
    CREATE INDEX order_browser_rate ON orders(pending_browser_hash, created_at)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE customer_identity_signing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    ) STRICT;
    INSERT INTO customer_identity_signing VALUES (1, lower(hex(randomblob(32))));
    PRAGMA user_version = 1;
  `)
}
