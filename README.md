# QR Restaurant Ordering · Final local demo

This local proof of concept uses Urban Bites as its demo restaurant. The launcher opens public table menus and authenticated staff workspaces for cashier operations, kitchen tickets, and table management with printable QR signs.

| Route | Audience and workflow |
| --- | --- |
| `/` | Public launcher |
| `/menu/:tableCode` | Customer menu, cart, receipts, and authorized sitting state |
| `/cashier` | Staff verification, sitting authorization, bills, and settlement |
| `/kitchen` | Staff preparation and serving queue |
| `/tables` | Staff table states, QR links, downloads, and print previews |

The React frontend calls an Express API using same-origin requests. SQLite stores authoritative state, and authenticated Socket.IO events tell open interfaces to refresh. Vite serves the frontend and proxies API and socket requests in development. Express can serve the built frontend locally.

## Quick start

Use Node.js 24 or 26 and npm from the project directory.

```sh
npm ci
npm run db:init
npm run db:seed
npm run dev
```

Open `http://localhost:5173`. The server initializes the schema on startup as well. Seeding is explicit and can be repeated. The initial seed creates 10 tables and 15 items across five categories.

For a clean presentation, use `npm run db:demo` to create `data/demo.sqlite` from the ten permanent identifiers in `data/ordering.sqlite`. The command opens the source read-only, refuses to overwrite its destination, seeds the canonical menu, and creates fresh authentication state. Start it from PowerShell with `$env:DATABASE_PATH = 'data/demo.sqlite'` and then `npm run dev`. To repeat from a new file, run `npm run db:demo -- data/ordering.sqlite data/demo-repeat.sqlite` and select that new path. The automated and browser tests use isolated in-memory or temporary files. See [DEMO_GUIDE.md](DEMO_GUIDE.md) for the timed walkthrough, LAN setup and physical-device checklist.

For staff access, set a private `STAFF_CREDENTIAL` in the local ignored `.env` file or shell environment before starting the backend. If the setup generated a local credential, read it from `.env`. The same staff session permits access to `/cashier`, `/kitchen`, and `/tables`. Without a configured credential, staff sign-in is disabled and the customer menu remains available.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Express in watch mode and the Vite development server |
| `npm run build` | Compile the backend and generate frontend assets |
| `npm start` | Serve the built frontend, API and Socket.IO locally from Express |
| `npm run typecheck` | Check backend and frontend TypeScript |
| `npm run lint` | Run ESLint |
| `npm test` | Run all automated backend, security, concurrency, and migration checks |
| `npm run test:browser` | Build and run customer, cashier, kitchen, table, and print-preview checks |
| `npm run db:init` | Initialize the SQLite schema |
| `npm run db:seed` | Insert missing demo records |
| `npm run db:demo` | Create a separate clean demo database, preserving the permanent table IDs |

## Environment and local network

Copy `.env.example` to `.env` to override defaults. Shell environment variables take precedence.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKEND_HOST` | `127.0.0.1` | Express bind address |
| `BACKEND_PORT` | `3001` | Express HTTP and Socket.IO port |
| `FRONTEND_HOST` | `127.0.0.1` | Vite binds locally by default. Set `0.0.0.0` explicitly for a trusted LAN demonstration. |
| `FRONTEND_PORT` | `5173` | Vite HTTP port |
| `DATABASE_PATH` | `data/ordering.sqlite` | SQLite file, relative to the project root or absolute |
| `SECURE_COOKIES` | `false` | Set to `true` when using HTTPS, including behind a TLS-terminating proxy |
| `STAFF_CREDENTIAL` | Unset | Shared cashier and kitchen password, configured on the server |
| `QR_BASE_URL` | `http://localhost:5173` with defaults | Initial QR origin, editable per staff browser. Without an override, the localhost port follows `FRONTEND_PORT`. |

For LAN testing, run `ipconfig` to find the host's active IPv4 address. Set `$env:FRONTEND_HOST = '0.0.0.0'` before running Vite. With both devices on the same trusted network, open `http://<host-ip>:5173` on the second device. If prompted by Windows Firewall, allow TCP 5173 for the private network. The API and Socket.IO remain on loopback behind Vite. For the local built application, set `BACKEND_HOST=0.0.0.0`, run `npm start`, and use port 3001 with the default configuration. Vite's file allowlist is restricted to the frontend and build dependencies. SQLite and environment files are excluded.

To generate an SVG for a seeded table, run the following in PowerShell with your actual LAN address.

```powershell
node backend/src/qr-cli.ts http://192.168.1.10:5173 01 | Set-Content -Encoding utf8 table-01.svg
```

Table codes persist with the database. A printed QR encodes the origin as well, so keep the origin stable if you want to reuse the printed code. A fresh database generates fresh codes.

## Directory layout

```text
backend/
  src/                 Express, Socket.IO, SQLite schema, seed and QR CLI
  tsconfig.json
frontend/
  src/                 React routes, launcher and Tailwind styles
  index.html
  vite.config.ts
  tsconfig.json
tests/                 API, schema, realtime, and browser tests for Phases 1–5
data/                  Local SQLite files, generated and ignored
.env.example
eslint.config.js
package.json
package-lock.json
```

## Database

| Table | Relationships and constraints |
| --- | --- |
| `restaurant_tables` | Unique table numbers and public codes. SQLite rejects updates to public codes. |
| `menu_categories` | Unique category slugs and display order. |
| `menu_items` | References a category. Stores slug, description, availability, display order and price in minor units. |
| `table_sessions` | References a table. A partial unique index permits one row with no closure timestamp per table. |
| `browser_authorizations` | References a session. Stores a unique token hash and an optional revocation timestamp. |
| `orders` | References a table. Optional composite foreign keys tie an authorized order to the matching table session and browser authorization. Initial pending orders can store a browser hash with no session or authorization. Approval and kitchen statuses require an approval timestamp and a session link. |
| `order_items` | References an order and menu item. Stores the name and unit price at ordering time, plus a positive quantity. |

Foreign keys are enabled on each connection. The schema uses strict tables and indexes for menu lookup, session history, authorization and order lookups. The active authorization view excludes revoked authorizations and authorizations for closed sessions while retaining history. Future approval logic can create the first session, authorize its browser and approve the first order in one transaction. The read endpoints perform no session or order mutations.

## Public API

| Method and path | Response |
| --- | --- |
| `GET /api/health` | Database-backed health check returning `{"status":"ok"}` |
| `GET /api/menu` | Restaurant name, currency and ordered categories and menu items. Each item exposes slug, name, description, availability and integer `priceMinor`. |
| `GET /api/demo/tables` | Restaurant name and demo table numbers with their public codes |
| `GET /api/tables/:tableCode` | Table number and code for a valid identifier. Malformed codes return 400 and unknown codes return 404. |

The public launcher enumerates table codes for this local demo. Those codes identify tables and provide no session access.

## Dependencies and design decisions

- React and React DOM render the browser interface. React Router resolves the five routes.
- Vite and its React plugin handle local startup and bundling. Tailwind CSS and its Vite plugin handle styles.
- Express handles HTTP routing and errors. Socket.IO provides the realtime transport. The Socket.IO client verifies connections in tests.
- Node's built-in SQLite driver handles the database. Node's test runner handles verification. [Node SQLite documentation](https://nodejs.org/api/sqlite.html)
- QRCode generates local table SVGs. Concurrently runs both development processes. TypeScript and the `@types/*` packages supply type checking. ESLint and typescript-eslint enforce lint rules.
- The restaurant identity and demo catalog live in backend data modules. The browser receives branding through the API. The development proxy keeps browser HTTP and Socket.IO requests on one origin. [Vite server proxy documentation](https://vite.dev/config/server-options.html#server-proxy)

## Customer ordering API

| Method and path | Contract |
| --- | --- |
| `GET /api/tables/:tableCode/orders/latest` | Returns `{ order: null }` or the latest order for the current browser and table. Issues the browser cookie when missing or invalid. |
| `POST /api/tables/:tableCode/orders` | Accepts JSON containing `idempotencyKey` (32 lowercase hexadecimal characters) and `items` (1–30 lines). Each line accepts a menu `slug`, integer `quantity` from 1 to 20, and optional `instructions` up to 240 characters. Returns `{ order }` with HTTP 201 for a new order or 200 for a replay. |

The order object contains `reference`, `idempotencyKey`, `status`, `tableNumber`, `currency`, `totalMinor`, and `items`. Returned lines contain `name`, `unitPriceMinor`, `quantity`, and `instructions`. Customer status is `pending`, `approved`, `preparing`, `ready`, `served`, `rejected`, or `session-closed`. For a closed sitting, the owner's receipt also exposes `preparationStatus` for that order. The POST takes prices and availability from the database. An optional `sessionKey` is an expectation about the browser's current authorization. The server resolves the actual grant independently. Validation failures return an `error` object with a `code` and `message`. A missing or invalid browser cookie returns 401, cross-origin submissions return 403, stale session expectations, a bill lock or reuse of a key with a changed payload return 409, and missing or unavailable items return 422. Order endpoints use private, no-store caching.

| Method and path | Phase 3 customer contract |
| --- | --- |
| `GET /api/tables/:tableCode/orders/session` | Returns `{ session: null }` when the browser lacks a current grant. Otherwise returns the browser-bound `key`, `billRequested`, `confirmedTotalMinor`, `pendingTotalMinor`, confirmed `orders` and the browser’s own authorized `pending` orders. |
| `POST /api/tables/:tableCode/orders/bill` | Requires the current browser and `{ sessionKey }`. Returns 204 for a successful request or replay, 403 without authorization, and 409 for a stale key. |

### Migration and identity

Schema version 1 adds nullable order references, idempotency keys and request digests, plus an item instructions column with a default of empty text. Historical rows and table identifiers survive the migration. The SQLite migration runs in a transaction and stores a local signing secret in a singleton table.

The server issues a 256-bit random browser credential signed with HMAC-SHA-256 in an HttpOnly, SameSite=Lax cookie. Phase 3 moves the cookie to the site root for Socket.IO and retires the legacy path while preserving the credential. HTTPS can enforce Secure cookies through `SECURE_COOKIES=true`. An order stores a SHA-256 digest in the existing `pending_browser_hash` column. Cookie loss or changing the host can prevent receipt recovery. Browser identity alone grants no table-session access. Cashier verification grants access to a particular sitting and cannot prove continuing physical presence.

A transaction saves the order and its item snapshots. A unique browser-and-key index deduplicates retries. A digest of the normalized request rejects changed payloads under the same key. The browser stores carts by table code and retains the exact submission key across ambiguous failures and refreshes. The server allows up to six new orders per browser per minute and 30 per table per ten minutes. Excess requests return 429 with `Retry-After`. Replays use the original record and do not count against those limits.

### Socket.IO

| Event | Audience and payload |
| --- | --- |
| `order:requested` | Authenticated staff room. New requests only. `{ reference, tableNumber, status: 'pending' }`. |
| `cashier:changed` | Authenticated staff room. `{ kind }` invalidates the cashier snapshot. |
| `customer:changed` | Server-assigned private browser room in the `/customer` namespace. `{ kind }` invalidates the browser's own receipt and, where authorized, its session view. |
| `kitchen:changed` | Authenticated staff room. `{ kind, reference }` for `approved`, `preparing`, `ready`, or `served`. Settlement sends `{ kind: 'settled' }`. |

Cashier and customer change kinds are `submitted`, `approved`, `rejected`, `session-created` (includes approval of the first request), `browser-revoked`, `bill-requested`, `ordering-reopened`, `settled`, `preparing`, `ready`, and `served`. Events are emitted after commits. Customers connect with their signed cookie and cannot select rooms. For a shared change, the server resolves current grant holders from SQLite and sends lightweight invalidations to their private browser rooms. Revocation and settlement remove those grants from subsequent shared fan-out. The browser room remains usable for the owner's private receipts. Kitchen, cashier, and customer clients refetch authoritative snapshots on reconnect and periodically while disconnected.

## Cashier API and sitting lifecycle

Staff sessions use a separate random, opaque cookie with HttpOnly, SameSite=Strict and optional Secure. The database stores a digest bound to the configured credential with an eight-hour server-side expiration. A credential change requires staff to sign in again. Logout deletes the session and disconnects its staff sockets. Five failed sign-ins within five minutes limit subsequent attempts for the connection address. The shared credential provides one staff role for a controlled demonstration. It provides no per-employee attribution, and the development proxy can make clients share one sign-in rate-limit bucket. Local HTTP is intended for a trusted network. Browser authorization does not establish continuing physical presence.

All paths below are under `/api/staff`. Successful state-changing operations return 204 except login.

| Method and path | Contract |
| --- | --- |
| `POST /login` | Accepts `{ credential }`. Returns the restaurant name and sets the staff cookie. Returns 429 if rate-limited or 503 if unconfigured. |
| `GET /session`, `POST /logout` | Validates or revokes the staff session. |
| `GET /overview` | Returns branding, currency, table count, the classified pending queue with order details and review keys, and active sessions with totals, orders and display-only browser identifiers. |
| `POST /orders/:reference/approve` | Requires `{ reviewKey, verified }`. Physical verification is mandatory for first orders and unknown browsers. |
| `POST /orders/:reference/reject` | Rejects a pending request and records its timestamp. |
| `POST /sessions/:id/browsers/:authorizationId/revoke` | Revokes the specified browser grant for that session. |
| `POST /sessions/:id/reopen` | Requires `{ billRevision }`. Clears the bill request and reopens ordering. |
| `POST /sessions/:id/settle` | Requires `{ billRevision, totalMinor, confirmed: true }`. Records external collection, closes the session and revokes its grants. |

Unauthenticated operational requests return 401. Stale reviews, unresolved requests, changed totals or invalid transitions return 409 with an error code and message. Approval or rejection replay for the same decision leaves the persisted order intact.

1. The first request remains separate until the cashier physically verifies it. Approval creates the session and browser grant in the same transaction as the order approval.
2. A request submitted with a valid grant is linked to the sitting and stays pending. An unknown browser's request stays unlinked until explicitly verified. A stale or revoked linked request can be rejected. Confirmed totals include approved orders only.
3. A bill request locks submissions for all browsers at the table. Existing requests remain in the queue. The cashier can reopen ordering or resolve all current-sitting pending requests and settle the confirmed amount.
4. Settlement records the final total and close timestamp, revokes grants, and advances the table's sitting generation. Table availability follows from the absence of an active session. The permanent table URL remains valid for a later sitting.

Schema version 2 adds table and request sitting generations, order rejection timestamps, bill request state and revision, final settled totals, the session-bound browser identity digest, and staff sessions. Legacy unlinked pending requests with existing session history are conservatively flagged for rejection because their original sitting cannot be proven. The review key binds approval to the observed generation, active session and verification classification. SQLite write transactions serialize submission, authorization, approval, bill changes and settlement. The partial unique active-session index and composite foreign keys stay in place. The single-process demo uses SQLite as the source of truth for reads and writes and Socket.IO as a transient notification transport.

### Art and browser checks

The demo has 15 generated item images and a generated hero image, all stored locally in [frontend/public/menu-images](frontend/public/menu-images). These illustrate the fictional menu. See [image provenance](frontend/public/menu-images/PROVENANCE.md) for the generation prompts. An item with no image uses a local fallback.

Playwright uses the installed Microsoft Edge browser by default on Windows. On systems without Edge, set `ORDERING_TEST_BROWSER` to an installed Chromium browser channel, or use Playwright's Chromium install on a non-Windows host. [Playwright browser documentation](https://playwright.dev/docs/browsers#microsoft-edge)

## Kitchen display

| Method and path | Contract |
| --- | --- |
| `GET /api/staff/kitchen` | Returns `{ restaurant, tickets }`. Tickets include reference, table number, state, approval and applicable preparation timestamps, a closed-sitting timestamp when applicable, additional-order flag, and name, quantity and instructions per item. |
| `POST /api/staff/kitchen/orders/:reference/start` | Approved → preparing. |
| `POST /api/staff/kitchen/orders/:reference/ready` | Preparing → ready. |
| `POST /api/staff/kitchen/orders/:reference/serve` | Ready → served. |

Kitchen actions take no status or price input. A transition succeeds with 204 and records its timestamp in the same transaction. Repeating an action while the order is already at its target stage returns 204 and preserves the timestamp. A stale, backward, skipped or ineligible action returns 409. Unauthenticated requests return 401, and unknown references return 404. Staff sessions and socket room access use the same authorization as the cashier.

Schema version 3 adds three nullable lifecycle timestamps, a flag to record additional orders at approval, and an active queue index. Phase 4 reuses the existing order statuses and retains the original approval timestamp. Legacy active tickets keep their saved state and use approval timestamp and ID to infer the initial ticket. Historical transition timestamps that were never recorded remain unset.

Prepared or served orders stay in the same financial inclusion set as approved orders. Served tickets leave the active board while preserving their history. A settlement warning identifies unfinished tickets. Cashiers may still settle, and the kitchen keeps each unfinished ticket in its original stage with a **Sitting closed** label and its original sitting association. A later sitting at the same table has separate orders and browser grants.

The board defaults to muted. **Enable sound** unlocks a short local Web Audio chime for a previously unseen live approval. Initial loads and reconnect snapshots remain silent. All approved arrivals have a visible ticket in the New orders lane.

## Table management and print signs

The staff-only `/tables` workspace shows all seeded tables. The available count includes tables with first requests awaiting verification. The occupied count includes tables with bill requests. Pending request amounts include unresolved requests in the current table generation, including unverified requests. Only approved orders contribute to the confirmed amount. Each table links to its filtered cashier queue and current sitting. Staff actions still go through the existing cashier verification and settlement endpoints.

| Method and path | Contract |
| --- | --- |
| `GET /api/staff/tables` | Returns restaurant branding, currency, `defaultBase`, and the table grid with permanent codes, derived states, request counts and amounts, and active sitting summaries. |
| `POST /api/staff/tables/qr-base` | Validates `{ baseUrl }` and returns the normalized origin and `loopback` flag. Invalid addresses return 400. |
| `GET /api/staff/tables/:number/qr/:format?baseUrl=…` | Renders SVG or PNG for an existing table. Use `download=1` for attachment disposition. Unknown numbers and formats return 404. |

Table management listens for authorized `cashier:changed` invalidations covering order, billing, browser-authorization, and kitchen changes. It refetches after reconnecting. Phase 5 adds no socket events or database migration. QR endpoints only look up permanent table identifiers and render images. A QR encodes the menu URL and gives the scanner no sitting privileges.

On Windows, use `ipconfig` to find the active Wi-Fi or Ethernet adapter's IPv4 address. With Vite running and the scanning device on the same network, enter an origin such as `http://192.168.1.10:5173` under **QR address**, using the host's actual IP and frontend port. For the local built application, use the port Express serves instead. For single-computer use, keep `http://localhost:5173`. For a future stable HTTPS address, enter its HTTPS origin. Host headers are not used as QR configuration. Addresses with credentials, paths, queries, fragments or non-HTTP protocols are rejected. The normalized choice is stored in the staff browser and applies to previews and downloads. Changing the origin leaves the underlying table identifier intact. A sign already printed continues to encode its original origin.

**Print table sign** and **Print all QR codes** open previews before invoking the print dialog. The stylesheet produces approximately A6-size signs on A4 paper. Bulk uses four signs per page with a four-module QR quiet zone and up to three pages for ten tables. Choose A4 and actual size where available, and disable browser headers and footers if your browser adds them. **Save as PDF** is available through the browser. QR generation does not establish whether the selected address can be reached from a physical device.

External POS and payment processing remain outside this local demonstration. Settlement records collection outside the app.

The final audit uses schema version 3. Visible clients reconcile periodically and on reconnect even when an event is missed. The customer interface hides protected sitting data when authorization refresh is unavailable. See [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) for the defect register and [DEMO_GUIDE.md](DEMO_GUIDE.md) for the checks that require physical devices.
