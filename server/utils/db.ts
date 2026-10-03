import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { databasePath } from './config'

let instance: BetterSQLite3Database<typeof schema> | null = null

export function useDb() {
  if (!instance) {
    const path = databasePath()
    mkdirSync(dirname(path), { recursive: true })
    const sqlite = new Database(path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    instance = drizzle(sqlite, { schema })
  }
  return instance
}

export { schema }
