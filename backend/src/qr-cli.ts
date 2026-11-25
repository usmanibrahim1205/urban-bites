import { openDatabase } from './database.ts'
import { createTableQr, parseQrOrigin } from './table-qr.ts'

const [base, number] = process.argv.slice(2)
if (!base || !number) throw new Error('Usage: node backend/src/qr-cli.ts <http-origin> <table-number>')
const origin = parseQrOrigin(base)

const db = openDatabase()
try {
  const table = db.prepare('SELECT public_code FROM restaurant_tables WHERE number = ?').get(number)
  if (typeof table?.public_code !== 'string') throw new Error('Table not found. Seed the database first.')
  process.stdout.write(await createTableQr(origin, table.public_code))
} finally {
  db.close()
}
