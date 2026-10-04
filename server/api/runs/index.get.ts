import { desc, inArray } from 'drizzle-orm'
import type { RunSummary } from '../../../shared/types'
import { schema, useDb } from '../../utils/db'
import { toRunSummary } from '../../utils/runs'

/** The 50 most recent pulls and cleanups, and the V0 syncs before them. */
export default defineEventHandler((): RunSummary[] =>
  useDb().select().from(schema.syncRuns).where(inArray(schema.syncRuns.kind, ['pull', 'cleanup', 'sync'])).orderBy(desc(schema.syncRuns.id)).limit(50).all().map(toRunSummary))
