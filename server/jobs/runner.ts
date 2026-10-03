// One run at a time, in-process, never inside a request handler. Progress is broadcast for SSE.
// An unfinished run (paused, failed, or interrupted by a restart) is resumed rather than restarted.
import { EventEmitter } from 'node:events'
import { desc, eq } from 'drizzle-orm'
import type { RunProgress } from '../../shared/types'
import { schema, useDb } from '../utils/db'
import { acquire, lockHolder, release } from './lock'
import { createRunLog, resetUnfinishedStages } from './run-log'
import { defaultOptions, runSync } from './sync'

/** An unfinished run older than this is abandoned and a fresh one starts. */
const RESUME_WINDOW_MS = 3 * 24 * 3600_000

const events = new EventEmitter()
let progress: RunProgress = { running: false, phase: 'idle', message: '', done: 0, total: 0, error: null, resumeAt: null, runId: null, rev: 0 }
let timer: ReturnType<typeof setTimeout> | null = null

export const getProgress = () => progress
export function onProgress(listener: (p: RunProgress) => void) {
  events.on('progress', listener)
  return () => events.off('progress', listener)
}

function update(patch: Partial<RunProgress>) {
  progress = { ...progress, ...patch }
  events.emit('progress', progress)
}

/** Run a sync automatically at `at` (sync only plans, so this never writes). */
export function scheduleSync(at: string) {
  if (timer) clearTimeout(timer)
  const delay = Math.max(1000, Math.min(Date.parse(at) - Date.now(), 2 ** 31 - 1))
  timer = setTimeout(() => {
    timer = null
    // A cleanup holds the lock: try again shortly rather than dropping the resume.
    if (startSync('schedule') === null && lockHolder() === 'cleanup') scheduleSync(new Date(Date.now() + 60_000).toISOString())
  }, delay)
  update({ resumeAt: at })
}

function unfinishedRun() {
  const latest = useDb().select().from(schema.syncRuns).where(eq(schema.syncRuns.kind, 'sync')).orderBy(desc(schema.syncRuns.id)).limit(1).get()
  if (!latest || latest.status === 'succeeded') return null
  return Date.now() - Date.parse(latest.startedAt) < RESUME_WINDOW_MS ? latest : null
}

/** After a restart: re-arm the timer of a paused run, or pick up a run the restart interrupted. */
export function restoreSchedule() {
  const run = unfinishedRun()
  if (run?.status === 'paused' && run.pause) scheduleSync(run.pause.resumeAt)
  else if (run?.status === 'running') scheduleSync(new Date(Date.now() + 5000).toISOString())
}

/** Start or resume a sync (plan only) unless one is running. Returns the run ID, or null when skipped. */
export function startSync(trigger: 'manual' | 'schedule' = 'manual'): number | null {
  if (progress.running || !acquire('sync')) return null
  if (timer) { clearTimeout(timer); timer = null }
  const db = useDb()

  const resumable = unfinishedRun()
  const run = resumable
    ? db.update(schema.syncRuns).set({ status: 'running', error: null, pause: null, trigger, attempts: resumable.attempts + 1, stages: resetUnfinishedStages(resumable.stages) })
      .where(eq(schema.syncRuns.id, resumable.id)).returning().get()
    : db.insert(schema.syncRuns).values({ kind: 'sync', trigger, startedAt: new Date().toISOString(), status: 'running', attempts: 1, stages: {} }).returning().get()
  update({ running: true, phase: 'start', message: resumable ? 'Resuming the unfinished sync' : 'Starting sync', done: 0, total: 0, error: null, resumeAt: null, runId: run.id })

  const log = createRunLog(run.id, () => update({ rev: progress.rev + 1 }))
  const by = trigger === 'schedule' ? 'automatically' : 'by you'
  log.event('info', null, resumable
    ? `Resumed ${by} (attempt ${run.attempts}${resumable.status === 'failed' ? ', after a failure' : resumable.status === 'running' ? ', after a restart' : ''})`
    : `Started ${by}`)

  runSync(run.id, (phase, message, done = 0, total = 0) => update({ phase, message, done, total }), undefined, defaultOptions(), log)
    .then(({ collections, pause, requests }) => {
      log.flush()
      const counts: Record<string, number> = { ...(run.counts ?? {}), collections: collections.length, add: 0, review: 0, pending: 0, unmatched: 0, in_sync: 0 }
      for (const c of collections) for (const k of ['add', 'review', 'pending', 'unmatched', 'in_sync'] as const) counts[k]! += c.counts[k]
      // Requests add up across resumes, so the total cost of a first sync is visible.
      counts.spotifyRequests = (run.counts?.spotifyRequests ?? 0) + requests.spotify
      counts.tidalRequests = (run.counts?.tidalRequests ?? 0) + requests.tidal

      db.update(schema.syncRuns).set({
        status: pause ? 'paused' : 'succeeded',
        finishedAt: pause ? null : new Date().toISOString(),
        pause,
        counts,
        ...(collections.length ? { result: collections } : {}),
      }).where(eq(schema.syncRuns.id, run.id)).run()

      if (pause) {
        // The stage that hit the limit already logged the warning; this is the run-level summary.
        log.event('info', null, `Paused: ${pause.message}. Progress is saved; resumes automatically at ${pause.resumeAt.slice(11, 16)} UTC`)
        update({ running: false, phase: 'paused', message: `${pause.message}. Progress is saved; continuing automatically.` })
        scheduleSync(pause.resumeAt)
      } else {
        log.event('info', null, `Finished after ${run.attempts === 1 ? 'one attempt' : `${run.attempts} attempts`}. Nothing was written to either service`)
        update({ running: false, phase: 'done', message: 'Sync finished. Nothing was written.' })
      }
    })
    .catch((error: Error) => {
      console.error('[sync] failed', error)
      const stage = log.current()
      if (stage) log.stage(stage, { status: 'failed', detail: error.message })
      log.event('error', stage, `Stopped: ${error.message}. Everything fetched and matched so far is saved; Sync resumes from here`)
      log.flush()
      db.update(schema.syncRuns).set({ status: 'failed', error: error.message }).where(eq(schema.syncRuns.id, run.id)).run()
      update({ running: false, phase: 'failed', message: 'Sync stopped. Progress is saved; Sync resumes it.', error: error.message })
    })
    .finally(() => release('sync'))

  return run.id
}
