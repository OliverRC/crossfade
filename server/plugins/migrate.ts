import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

export default defineNitroPlugin(() => {
  migrate(useDb(), { migrationsFolder: resolve(process.env.MIGRATIONS_PATH || 'server/db/migrations') })
})
