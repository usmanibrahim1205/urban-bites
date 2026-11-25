import type { DatabaseSync } from 'node:sqlite'

export function migrateSessions(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 2) return
  db.exec(`
    ALTER TABLE restaurant_tables ADD COLUMN sitting_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN sitting_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN rejected_at TEXT;
    ALTER TABLE table_sessions ADD COLUMN bill_requested_at TEXT;
    ALTER TABLE table_sessions ADD COLUMN bill_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE table_sessions ADD COLUMN settled_total_minor INTEGER CHECK (settled_total_minor >= 0);
    ALTER TABLE browser_authorizations ADD COLUMN browser_identity_hash TEXT;
    UPDATE restaurant_tables SET sitting_generation = (
      SELECT count(*) FROM table_sessions WHERE table_id = restaurant_tables.id AND closed_at IS NOT NULL
    );
    -- A legacy, unlinked request cannot establish which sitting it belongs to if the table has session history.
    UPDATE orders SET sitting_generation = -1
      WHERE status = 'pending' AND EXISTS (SELECT 1 FROM table_sessions WHERE table_id = orders.table_id);
    CREATE INDEX table_sitting_queue ON orders(table_id, sitting_generation, status);
    CREATE UNIQUE INDEX active_session_browser ON browser_authorizations(session_id, browser_identity_hash)
      WHERE revoked_at IS NULL AND browser_identity_hash IS NOT NULL;
    CREATE TABLE staff_sessions (
      credential_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX staff_session_expiry ON staff_sessions(expires_at);
    PRAGMA user_version = 2;
  `)
}
