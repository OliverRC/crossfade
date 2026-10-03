import type { RunSummary } from '../../shared/types'
import type { schema } from './db'

export function toRunSummary(r: typeof schema.syncRuns.$inferSelect): RunSummary {
  return {
    id: r.id, trigger: r.trigger, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
    attempts: r.attempts, pause: r.pause, error: r.error, counts: r.counts, stages: r.stages ?? {},
  }
}
