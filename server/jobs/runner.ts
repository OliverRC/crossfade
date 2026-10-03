// One run at a time, in-process, never inside a request handler. Progress is broadcast for SSE.
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import type { RunProgress } from '../../shared/types'
import { schema, useDb } from '../utils/db'
import { runSync } from './sync'

const events = new EventEmitter()
let progress: RunProgress = { running: false, phase: 'idle', message: '', done: 0, total: 0, error: null }

export const getProgress = () => progress
export function onProgress(listener: (p: RunProgress) => void) {
  events.on('progress', listener)
  return () => events.off('progress', listener)
}

function update(patch: Partial<RunProgress>) {
  progress = { ...progress, ...patch }
  events.emit('progress', progress)
}

/** Start a sync (plan only) unless one is running. Returns the run ID, or null when skipped. */
export function startSync(trigger: 'manual' | 'schedule' = 'manual'): number | null {
  if (progress.running) return null
  const db = useDb()
  const run = db.insert(schema.syncRuns).values({ kind: 'sync', trigger, startedAt: new Date().toISOString(), status: 'running' }).returning().get()
  update({ running: true, phase: 'start', message: 'Starting sync', done: 0, total: 0, error: null })

  runSync((phase, message, done = 0, total = 0) => update({ phase, message, done, total }))
    .then((collections) => {
      const counts = { collections: collections.length, add: 0, review: 0, unmatched: 0, in_sync: 0 }
      for (const c of collections) for (const k of ['add', 'review', 'unmatched', 'in_sync'] as const) counts[k] += c.counts[k]
      db.update(schema.syncRuns).set({ status: 'succeeded', finishedAt: new Date().toISOString(), counts, result: collections }).where(eq(schema.syncRuns.id, run.id)).run()
      update({ running: false, phase: 'done', message: 'Sync finished. Nothing was written.' })
    })
    .catch((error: Error) => {
      console.error('[sync] failed', error)
      db.update(schema.syncRuns).set({ status: 'failed', finishedAt: new Date().toISOString(), error: error.message }).where(eq(schema.syncRuns.id, run.id)).run()
      update({ running: false, phase: 'failed', message: 'Sync failed', error: error.message })
    })

  return run.id
}
