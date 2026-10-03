import { asc, eq } from 'drizzle-orm'
import type { RunDetail } from '../../../shared/types'
import { schema, useDb } from '../../utils/db'
import { toRunSummary } from '../../utils/runs'

/** One run with its stages and full event log. */
export default defineEventHandler((event): RunDetail => {
  const id = Number(getRouterParam(event, 'id'))
  const db = useDb()
  const run = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)).get()
  if (!run) throw createError({ statusCode: 404, statusMessage: 'No such run' })
  const events = db.select({ id: schema.syncEvents.id, at: schema.syncEvents.at, level: schema.syncEvents.level, stage: schema.syncEvents.stage, message: schema.syncEvents.message })
    .from(schema.syncEvents).where(eq(schema.syncEvents.runId, id)).orderBy(asc(schema.syncEvents.id)).all()
  return { ...toRunSummary(run), events }
})
