import { config } from './config.ts'
import { openDatabase } from './database.ts'
import { seedDemo } from './seed.ts'

const command = process.argv[2]
if (command !== 'init' && command !== 'seed') {
  throw new Error('Expected init or seed')
}

const db = openDatabase()
try {
  if (command === 'seed') seedDemo(db)
  console.log(`Database ${command === 'seed' ? 'seeded' : 'initialized'} at ${config.databasePath}`)
} finally {
  db.close()
}
