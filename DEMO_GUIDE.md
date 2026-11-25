# Urban Bites demonstration guide

Urban Bites is a standalone local restaurant ordering demonstration. The cashier's confirmation replaces an internal order-entry step in this demo. Settlement records payment collected outside the application. The demo has no POS integration or payment processor.

## Start on Windows

Use PowerShell from `D:\QR Ordering`, with Node.js 24 or 26 and npm.

```powershell
Set-Location 'D:\QR Ordering'
npm ci
if (-not (Test-Path -LiteralPath 'data/demo.sqlite')) { npm run db:demo }
$env:DATABASE_PATH = 'data/demo.sqlite'
npm run dev
```

Run `npm run db:demo` only if the clean demo file has not already been created. For a fresh repeat, use `npm run db:demo -- data/ordering.sqlite data/demo-repeat.sqlite` and point `DATABASE_PATH` at that new file. The command reads the source identifiers, creates the destination exclusively, and seeds the standard menu. The source and any existing destination are preserved. Run tests separately with `npm test` and `npm run test:browser`. They use in-memory or disposable SQLite files.

Open `http://localhost:5173` for the launcher or go directly to `/cashier`, `/kitchen`, and `/tables`. Sign in using the private `STAFF_CREDENTIAL` from the ignored local `.env` file or your shell environment. Phase 6 requires a fresh sign-in for sessions created with older builds. If sign-in is unavailable, set a private credential and restart the backend. Keep the value out of slides and screenshots.

## Devices and QR address

Use a Windows host, a customer phone, and a landscape monitor or tablet for the kitchen where available. A single computer with separate browser profiles or a private window can demonstrate separate customers. Tabs in the same browser context normally share one browser identity. A printer is optional.

For a trusted LAN demonstration, stop the app and run `ipconfig`. Find the IPv4 address of the active Wi-Fi or Ethernet adapter. Connect the phone and host to the same private network or suitable hotspot. In the same PowerShell window run:

```powershell
$env:DATABASE_PATH = 'data/demo.sqlite'
$env:FRONTEND_HOST = '0.0.0.0'
npm run dev
```

Open `http://<host-ip>:5173` on the phone first. Visit **Table management**, set **QR base URL** to that same origin, and apply it. Use the actual port if configured differently. Localhost is suitable for a single computer. Set the LAN origin before generating or printing a sign intended for another device.

## Three-to-five-minute walkthrough

1. **0:00–0:45.** Show Table 04 as available in Table management. Open its generated QR with the phone or a separate customer browser. Add two Classic Zingers with “No lettuce” and one Regular Fries with “Light salt”. The initial total is PKR 1,350.
2. **0:45–1:30.** Send the order. Show the pending first request on the cashier screen and the empty kitchen queue. Confirm that the ordering customer is at the table, then approve. Show the occupied table and live customer confirmation.
3. **1:30–2:15.** In the kitchen, enable sound before the next approved order. Start preparing, mark ready, then mark served. Show the customer status and cashier history. Submit two Pepsis from the authorized browser, approve them, and complete the separate kitchen ticket.
4. **2:15–3:15.** Open the same QR in a different browser. Show that this browser cannot see the bill, then send a request. The cashier should label it Unknown browser. Reject it and confirm that the seated customer's bill remains PKR 1,590.
5. **3:15–4:30.** From the authorized browser, request the bill. Show that ordering is locked. Settle after confirming external collection. Start another sitting with a different browser. Reopen the saved QR in the original browser and show that it cannot access the new bill. A new request would require verification again.

Browser authorization does not establish continuing physical presence. A remote browser can submit an unverified request from a saved link. Cashier verification is what prevents silent attachment to a sitting.

## Physical-device checklist

**Current status** · Pending owner verification. Desktop, tablet, and mobile browser viewports, digital QR decoding, and browser PDF rendering were checked separately.

- [ ] Start Windows services with the demo database and explicit trusted-LAN binding.
- [ ] Identify the host IPv4 address, use the same network on the phone, and confirm the phone can open the launcher.
- [ ] Configure the QR base, open the cashier and kitchen, enable kitchen sound, and scan Table 04 using the phone camera.
- [ ] Submit a phone order, see it appear live in the cashier, physically verify it, and approve.
- [ ] Check the kitchen's live ticket and audible chime. Advance the ticket and check the phone statuses.
- [ ] Request and settle the bill. Check that a saved link grants no access to a later sitting.
- [ ] If a printer is available, preview and print one sign at actual size on A4. Scan the printed sign. Optionally print all ten and verify the page breaks.

## Troubleshooting and limitations

| Symptom | Check |
| --- | --- |
| Phone cannot reach the host | Check the active adapter address in `ipconfig`, the running Vite port, and the explicit LAN bind. Use the IPv4 address of the active Wi-Fi or Ethernet adapter. |
| Windows Firewall prompts or blocks access | Allow the selected frontend TCP port on the private network under your local policy. Keep the backend on loopback when Vite proxies it. |
| Same Wi-Fi, still no access | Guest networks may isolate clients. Use a trusted network or a suitable hotspot that allows device-to-device connections. |
| Phone tries to open localhost | Change the QR origin to the host IPv4 address and regenerate the sign. Printed signs keep the address they originally encoded. |
| No kitchen chime | Click **Enable sound** in the kitchen before an approval. Check tab and system volume. Existing tickets and reconnect snapshots stay silent. |
| Live status shows reconnecting | Confirm both dev processes are up and the frontend host is reachable. Wait for the socket to reconnect and reconcile, or refresh. After a lost submission response, use the existing retry action. |
| Wrong staff password or expired session | Check the private credential and sign in again. Multiple clients behind the local proxy can share the failed-login rate-limit bucket. |
| Sign clips or adds URL/header text | Use A4, actual size, and disable the browser's print headers and footers. Preview first. |

This is a single-process trusted-LAN demo with a shared staff credential. Local HTTP relies on the trust of that network. Physical QR readability, speaker output, printer settings, and actual phone reachability require the checks above.
