# Urban Bites on Render Free

This is a deployment runbook for use after review. The compatibility branch keeps the audited React, Express, SQLite, and Socket.IO stack. Express serves the compiled frontend, API, and Socket.IO on one port. Node.js 26.13.0 is pinned in `.node-version` and the Blueprint.

## Publish the private GitHub repository after approval

1. In GitHub, confirm the intended account or organization. Create an empty **private** repository named **urban-bites**. Leave README, license, and ignore-file initialization unchecked.
2. In PowerShell, add the remote for the confirmed owner. Before pushing, verify the remote and inspect the tracked files.

```powershell
Set-Location 'D:\QR Ordering'
git status --short --branch
git remote add origin https://github.com/CONFIRMED-OWNER/urban-bites.git
git remote -v
git push -u origin main
git push -u origin render-compatibility
git push origin phase-6-baseline
```

The `main` branch and `phase-6-baseline` tag preserve the audited local application. The Render service should use `render-compatibility`. Never stage local databases, sidecars, credentials, secret environment files, or test output. The table manifest contains only public QR identifiers and their table numbers.

## Deploy after approval

Either create a **Blueprint** in Render from the private repository using the `render-compatibility` branch and review its proposed resources, or use **New → Web Service** and enter these settings. Both workflows can trigger an initial deployment when confirmed. Use an Urban Bites service and confirm the selected workspace before creating it.

| Setting | Value |
| --- | --- |
| Name | `urban-bites` |
| Branch | `render-compatibility` |
| Root directory | Repository root. Leave the field blank. |
| Language and instance | Node and Free |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Auto-deploy | Off |
| Disk and other resources | None |

| Environment variable | Configuration |
| --- | --- |
| `NODE_VERSION` | `26.13.0` |
| `NODE_ENV` | `production` |
| `STAFF_CREDENTIAL` | Hosted-only random secret. The Blueprint generates one. For manual setup generate an independent 256-bit value and store it in Render's environment settings. |
| `BROWSER_SIGNING_SECRET` | Independent base64-encoded 32-byte secret. The Blueprint generates one. Use the same format for a manually generated value. |
| `RENDER`, `PORT`, `RENDER_EXTERNAL_URL` | Render supplies these automatically. The external URL is the canonical HTTPS origin for browser mutations, WebSockets, and default QR generation. |

Keep the staff value in a password manager and read it only in an authorized session. Keep both secret values out of Git, logs, URLs, and client-side Vite variables. On Render, staff and browser cookies are always Secure and HttpOnly. Express trusts the nearest proxy hop for client information. Request and socket origin checks use the configured canonical URL independently of incoming Host and forwarding headers. Verify proxy header and WebSocket behavior on the actual service before sharing its URL.

## Database lifetime

Hosted SQLite uses `/tmp/urban-bites/ordering.sqlite` on Render Linux. It ignores the local `DATABASE_PATH`. Startup applies the existing migrations and seeds the 15 items and 10 public table identifiers idempotently. An existing file keeps its records and a conflicting table identifier prevents startup. New files use the same public table identifiers and a fresh database-specific signing salt, which is combined with the hosted signing secret. Cookies from the previous database cannot restore its sitting or staff sessions.

Render Free can spin down after 15 minutes with no inbound traffic. Cold starts may take about a minute. A restart, deploy, or spin-down can discard all operating records. This setup is for fictional demonstration data. Use [Render Free limitations](https://render.com/docs/free) to check shared workspace usage and bandwidth or build allowances before enabling monitoring or sharing the service. The application never pings itself.

## Post-deploy acceptance and monitoring

1. Open `https://<actual-service>.onrender.com/api/health`. Confirm HTTP 200 and `{"status":"ok"}` without credentials. Open each direct frontend route, sign in, and check the Socket.IO connection using the actual HTTPS origin.
2. Confirm the QR default displays the actual service origin. Clear a stale per-browser override in table management by applying the real origin, then scan a generated QR and run the audited demo flow in separate browser contexts. Check first-order verification, kitchen transitions, and settlement.
3. If desired, after approval create an **HTTP(s)** monitor in UptimeRobot named **Urban Bites demo** for `https://<actual-service>.onrender.com/api/health`. Use the Free five-minute interval. If the UI permits a custom success status, select 200. Choose the intended alert contact and leave requests unauthenticated. A first wake-up may time out. External checks can keep the service active and use shared Free instance hours, so pause monitoring outside demonstration periods if you want Render to spin it down. [UptimeRobot setup](https://help.uptimerobot.com/en/articles/11358364-how-to-create-your-first-monitor-on-uptimerobot-quick-setup-guide) · [Monitoring intervals](https://help.uptimerobot.com/en/articles/11360876-what-is-a-monitoring-interval-in-uptimerobot)

Local verification uses `npm test`, `npm run test:browser`, `npm run test:render`, `npm run typecheck`, and `npm run lint`. The Render-mode smoke test starts compiled Express with disposable filesystem roots and synthetic HTTPS proxy metadata. It does not contact Render or write to the existing local databases.
