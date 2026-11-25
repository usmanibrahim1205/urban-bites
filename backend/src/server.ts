import { createApplication } from './app.ts'
import { config } from './config.ts'
import { openDatabase } from './database.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { seedDemo } from './seed.ts'
import { renderTableIdentifiers } from './render-table-identifiers.ts'
import { parseQrOrigin } from './table-qr.ts'

if (config.render) {
  const origin = parseQrOrigin(config.publicOrigin)
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.onrender.com') || origin.origin !== config.publicOrigin) {
    throw new Error('Render requires a canonical HTTPS RENDER_EXTERNAL_URL on onrender.com.')
  }
  if ((process.env.STAFF_CREDENTIAL?.length ?? 0) < 24) {
    throw new Error('Render requires a separate strong STAFF_CREDENTIAL.')
  }
  if (!existsSync(join(config.frontendDist, 'index.html'))) throw new Error('Run the build before starting Render.')
}

const db = openDatabase()
let application
try {
  if (config.render) seedDemo(db, renderTableIdentifiers)
  application = createApplication(db, config.frontendDist)
} catch (error) {
  db.close()
  throw error
}
const { server, io } = application
server.once('error', error => {
  console.error(error)
  db.close()
  process.exitCode = 1
})
server.listen(config.backendPort, config.backendHost, () => {
  console.log(`Backend listening on http://${config.backendHost}:${config.backendPort}`)
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  void io.close(() => db.close())
  server.closeAllConnections()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
