import { desc, eq, inArray } from 'drizzle-orm'
import type { RunStatus, SyncResult } from '../../shared/types'
import { schema, useDb } from '../utils/db'

/** The latest diff (provisional while a run is paused), the latest run's state, and the last 20 runs' change counts. */
export default defineEventHandler(() => {
  const db = useDb()
  const runs = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.kind, 'sync')).orderBy(desc(schema.syncRuns.id)).limit(20).all()
  const withResult = db.select().from(schema.syncRuns).where(inArray(schema.syncRuns.status, ['succeeded', 'paused', 'failed', 'running']))
    .orderBy(desc(schema.syncRuns.id)).all().find(r => r.result)
  const latest = runs[0]

  const result: SyncResult | null = withResult?.result
    ? { runId: withResult.id, finishedAt: withResult.finishedAt ?? withResult.startedAt, collections: withResult.result }
    : null
  const run: RunStatus | null = latest
    ? { id: latest.id, status: latest.status, phase: latest.phase, pause: latest.pause, error: latest.error, pending: latest.counts?.pending ?? 0 }
    : null

  return {
    result,
    provisional: Boolean(withResult && withResult.status !== 'succeeded'),
    run,
    runs: runs.reverse().map(r => (r.counts ? (r.counts.add ?? 0) + (r.counts.review ?? 0) + (r.counts.unmatched ?? 0) : 0)),
  }
})
