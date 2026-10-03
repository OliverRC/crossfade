import { desc, eq } from 'drizzle-orm'
import type { SyncResult } from '../../shared/types'
import { schema, useDb } from '../utils/db'

/** The most recent successful dry run, plus change counts of the last 20 runs for the equalizer. */
export default defineEventHandler(() => {
  const db = useDb()
  const latest = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.status, 'succeeded')).orderBy(desc(schema.syncRuns.id)).limit(1).get()
  const recent = db.select({ id: schema.syncRuns.id, status: schema.syncRuns.status, counts: schema.syncRuns.counts, error: schema.syncRuns.error })
    .from(schema.syncRuns).orderBy(desc(schema.syncRuns.id)).limit(20).all()
  const result: SyncResult | null = latest?.result
    ? { runId: latest.id, finishedAt: latest.finishedAt!, collections: latest.result }
    : null
  return {
    result,
    lastError: recent[0]?.status === 'failed' ? recent[0].error : null,
    runs: recent.reverse().map(r => (r.counts ? (r.counts.add ?? 0) + (r.counts.review ?? 0) + (r.counts.unmatched ?? 0) : 0)),
  }
})
