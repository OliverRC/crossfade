import { desc, eq } from 'drizzle-orm'
import type { RunSummary } from '../../../shared/types'
import { schema, useDb } from '../../utils/db'
import { toRunSummary } from '../../utils/runs'

/** The 50 most recent sync runs, without their diffs. */
export default defineEventHandler((): RunSummary[] =>
  useDb().select().from(schema.syncRuns).where(eq(schema.syncRuns.kind, 'sync')).orderBy(desc(schema.syncRuns.id)).limit(50).all().map(toRunSummary))
