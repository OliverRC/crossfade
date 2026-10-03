// What a run is doing, saved as it happens: per-stage status and progress on the run row, and an
// append-only event log. Status changes and events are written at once; progress counts at most once a second.
import { eq } from 'drizzle-orm'
import type { RunEvent, RunStages, StageKey, StageState } from '../../shared/types'
import { schema, useDb } from '../utils/db'

const PROGRESS_SAVE_MS = 1000
const FINAL: StageState['status'][] = ['done', 'paused', 'failed', 'skipped']

export interface RunLog {
  stage(key: StageKey, patch: Partial<Omit<StageState, 'startedAt' | 'finishedAt'>>): void
  event(level: RunEvent['level'], stage: StageKey | null, message: string): void
  /** The stage most recently set running, so a crash can be pinned on it. */
  current(): StageKey | null
  flush(): void
}

export function createRunLog(runId: number, onChange: () => void = () => {}): RunLog {
  const db = useDb()
  const stages: RunStages = db.select({ stages: schema.syncRuns.stages }).from(schema.syncRuns).where(eq(schema.syncRuns.id, runId)).get()?.stages ?? {}
  let current: StageKey | null = null
  let lastSave = 0
  let pending: ReturnType<typeof setTimeout> | null = null

  const save = () => {
    if (pending) { clearTimeout(pending); pending = null }
    lastSave = Date.now()
    db.update(schema.syncRuns).set({ stages, phase: current }).where(eq(schema.syncRuns.id, runId)).run()
  }

  return {
    stage(key, patch) {
      const now = new Date().toISOString()
      const prev: StageState = stages[key] ?? { status: 'waiting', startedAt: null, finishedAt: null, done: 0, total: 0, detail: null }
      const next: StageState = { ...prev, ...patch }
      const statusChanged = patch.status !== undefined && patch.status !== prev.status
      if (statusChanged && next.status === 'running') {
        next.startedAt = now
        next.finishedAt = null
        current = key
      }
      if (statusChanged && FINAL.includes(next.status)) next.finishedAt = now
      stages[key] = next

      if (statusChanged || Date.now() - lastSave >= PROGRESS_SAVE_MS) save()
      else pending ??= setTimeout(save, PROGRESS_SAVE_MS)
      onChange()
    },

    event(level, stage, message) {
      db.insert(schema.syncEvents).values({ runId, at: new Date().toISOString(), level, stage, message }).run()
      onChange()
    },

    current: () => current,
    flush: save,
  }
}

/** On resume, a stage left paused or failed starts over as waiting; finished ones keep their record. */
export function resetUnfinishedStages(stages: RunStages | null): RunStages {
  const out: RunStages = {}
  for (const [key, s] of Object.entries(stages ?? {}) as [StageKey, StageState][]) {
    out[key] = s.status === 'done' || s.status === 'skipped' ? s : { ...s, status: 'waiting', finishedAt: null }
  }
  return out
}
