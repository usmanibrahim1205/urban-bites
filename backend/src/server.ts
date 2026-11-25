import { createApplication } from './app.ts'
import { config } from './config.ts'
import { openDatabase } from './database.ts'

const db = openDatabase()
const { server, io } = createApplication(db, config.frontendDist)
server.once('error', error => {
  console.error(error)
  db.close()
  process.exitCode = 1
})
server.listen(config.backendPort, config.backendHost, () => {
  console.log(`Backend listening on http://${config.backendHost}:${config.backendPort}`)
})

function shutdown() {
  void io.close(() => db.close())
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
