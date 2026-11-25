export const schema = `
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  public_code TEXT NOT NULL UNIQUE CHECK (
    length(public_code) = 32 AND public_code NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TRIGGER IF NOT EXISTS permanent_table_code
BEFORE UPDATE OF public_code ON restaurant_tables
WHEN OLD.public_code <> NEW.public_code
BEGIN
  SELECT RAISE(ABORT, 'Table public code is permanent');
END;

CREATE TABLE IF NOT EXISTS menu_categories (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES menu_categories(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS menu_item_category ON menu_items(category_id, display_order);

CREATE TABLE IF NOT EXISTS table_sessions (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT CHECK (closed_at >= opened_at),
  UNIQUE (id, table_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_table
  ON table_sessions(table_id) WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS session_history ON table_sessions(table_id, opened_at);

CREATE TABLE IF NOT EXISTS browser_authorizations (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES table_sessions(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT CHECK (revoked_at >= created_at),
  UNIQUE (id, session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS authorization_session ON browser_authorizations(session_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES restaurant_tables(id),
  session_id INTEGER,
  authorization_id INTEGER,
  pending_browser_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rejected', 'approved', 'preparing', 'ready', 'served')),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT CHECK (approved_at >= created_at),
  CHECK (session_id IS NULL OR authorization_id IS NOT NULL),
  CHECK (authorization_id IS NULL OR session_id IS NOT NULL),
  CHECK (
    (status IN ('pending', 'rejected') AND approved_at IS NULL)
    OR (status IN ('approved', 'preparing', 'ready', 'served')
       AND approved_at IS NOT NULL AND session_id IS NOT NULL)
  ),
  FOREIGN KEY (session_id, table_id) REFERENCES table_sessions(id, table_id),
  FOREIGN KEY (authorization_id, session_id) REFERENCES browser_authorizations(id, session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS order_table ON orders(table_id, created_at);
CREATE INDEX IF NOT EXISTS order_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS order_authorization ON orders(authorization_id, session_id);
CREATE INDEX IF NOT EXISTS order_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  item_name TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS order_item_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_item_menu ON order_items(menu_item_id);

CREATE VIEW IF NOT EXISTS active_browser_authorizations AS
SELECT authorization.id, authorization.session_id, authorization.token_hash
FROM browser_authorizations AS authorization
JOIN table_sessions AS session ON session.id = authorization.session_id
WHERE authorization.revoked_at IS NULL AND session.closed_at IS NULL;
`
