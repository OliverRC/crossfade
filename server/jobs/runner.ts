// One job at a time, in-process, never inside a request handler. Progress is broadcast for SSE.
// A pull reads one service into main (docs/decisions/0005). An unfinished pull (paused, failed, or interrupted
// by a restart) is resumed rather than restarted, and a paused one resumes on its own.
import { EventEmitter } from 'node:events'
import { and, desc, eq } from 'drizzle-orm'
import type { ProviderId, RunProgress } from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import { QuotaError, requestCounts } from '../providers/http'
import { schema, useDb } from '../utils/db'
import { acquire, lockHolder, onRelease, release } from './lock'
import { runPull } from './pull'
import { runPush } from './push'
import type { PushWriter } from '../providers/types'
import { pruneStaged } from '../utils/staging'
import { providerNames, quotaBlockedUntil, quotaPause } from './quota'
import { createRunLog, resetUnfinishedStages } from './run-log'

/** An unfinished pull older than this is abandoned and a fresh one starts. */
const RESUME_WINDOW_MS = 3 * 24 * 3600_000

const events = new EventEmitter()
let progress: RunProgress = { running: false, phase: 'idle', message: '', done: 0, total: 0, error: null, resumeAt: null, runId: null, provider: null, rev: 0 }
const timers = new Map<ProviderId, ReturnType<typeof setTimeout>>()

export const getProgress = () => progress
export function onProgress(listener: (p: RunProgress) => void) {
  events.on('progress', listener)
  return () => events.off('progress', listener)
}

function update(patch: Partial<RunProgress>) {
  progress = { ...progress, ...patch }
  events.emit('progress', progress)
}

/** Pull a service automatically at `at`. A pull never writes to a service, so this is always safe. */
export function schedulePull(provider: ProviderId, at: string) {
  const existing = timers.get(provider)
  if (existing) clearTimeout(existing)
  const delay = Math.max(1000, Math.min(Date.parse(at) - Date.now(), 2 ** 31 - 1))
  timers.set(provider, setTimeout(() => {
    timers.delete(provider)
    // Another job holds the lock: try again shortly rather than dropping the resume.
    if (startPull(provider, 'schedule') === null && lockHolder()) schedulePull(provider, new Date(Date.now() + 60_000).toISOString())
  }, delay))
  update({ resumeAt: at })
}

function unfinishedPull(provider: ProviderId) {
  const latest = useDb().select().from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.kind, 'pull'), eq(schema.syncRuns.provider, provider))).orderBy(desc(schema.syncRuns.id)).limit(1).get()
  if (!latest || latest.status === 'succeeded') return null
  return Date.now() - Date.parse(latest.startedAt) < RESUME_WINDOW_MS ? latest : null
}

/** After a restart: re-arm the timer of a paused pull, or pick up one the restart interrupted. */
export function restoreSchedule() {
  for (const provider of PROVIDERS) {
    const run = unfinishedPull(provider)
    if (run?.status === 'paused' && run.pause) schedulePull(provider, run.pause.resumeAt)
    else if (run?.status === 'running') schedulePull(provider, new Date(Date.now() + 5000).toISOString())
  }
}

/** Pulls waiting for the running job. In memory: a restart drops the queue, never a pull already started. */
const queue: ProviderId[] = []

/**
 * Pull a service now, or after the running job when one is running. Returns the run ID when it started, 'queued' when
 * it waits, or null when that service is already pulling.
 */
export function pullOrQueue(provider: ProviderId): number | 'queued' | null {
  if (queue.includes(provider)) return 'queued'
  if (progress.running && progress.provider === provider && progress.phase !== 'push') return null
  const runId = progress.running || lockHolder() ? null : startPull(provider, 'manual')
  if (runId !== null) return runId
  queue.push(provider)
  update({ queued: [...queue] })
  return 'queued'
}

/** Take a service out of the queue. */
export function unqueuePull(provider: ProviderId) {
  const i = queue.indexOf(provider)
  if (i >= 0) queue.splice(i, 1)
  update({ queued: [...queue] })
}

// When a job lets go of the lock, the next queued pull starts. Deferred so the finished job settles first.
onRelease(() => setTimeout(() => {
  const next = queue[0]
  if (!next || progress.running || lockHolder()) return
  queue.shift()
  update({ queued: [...queue] })
  if (startPull(next, 'manual') === null) { queue.unshift(next); update({ queued: [...queue] }) }
}, 0))

/** Start or resume a pull of one service unless a job is running. Returns the run ID, or null when skipped. */
export function startPull(provider: ProviderId, trigger: 'manual' | 'schedule' = 'manual'): number | null {
  if (progress.running || !acquire('pull')) return null
  unqueuePull(provider)
  const timer = timers.get(provider)
  if (timer) { clearTimeout(timer); timers.delete(provider) }
  const db = useDb()
  const name = providerNames[provider]

  let run: typeof schema.syncRuns.$inferSelect
  try {
    const resumable = unfinishedPull(provider)
    run = resumable
      ? db.update(schema.syncRuns).set({ status: 'running', error: null, pause: null, trigger, attempts: resumable.attempts + 1, stages: resetUnfinishedStages(resumable.stages) })
        .where(eq(schema.syncRuns.id, resumable.id)).returning().get()
      : db.insert(schema.syncRuns).values({ kind: 'pull', provider, trigger, startedAt: new Date().toISOString(), status: 'running', attempts: 1, stages: {} }).returning().get()
    update({ running: true, phase: 'start', message: resumable ? `Resuming the ${name} pull` : `Pulling ${name}`, done: 0, total: 0, error: null, resumeAt: null, runId: run.id, provider, push: null })
    const log = createRunLog(run.id, () => update({ rev: progress.rev + 1 }))
    const by = trigger === 'schedule' ? 'automatically' : 'by you'
    log.event('info', null, resumable
      ? `Resumed ${by} (attempt ${run.attempts}${resumable.status === 'failed' ? ', after a failure' : resumable.status === 'running' ? ', after a restart' : ''})`
      : `Started ${by}`)

    runPull(run.id, provider, (phase, message, done = 0, total = 0) => update({ phase, message, done, total }), undefined, log)
      .then(({ pause, counts }) => {
        log.flush()
        const requestKey = `${provider}Requests`
        // Requests add up across resumes, so the total cost of a pull is visible.
        const totals = { ...counts, requests: undefined, [requestKey]: (run.counts?.[requestKey] ?? 0) + counts.requests }
        db.update(schema.syncRuns).set({
          status: pause ? 'paused' : 'succeeded',
          finishedAt: pause ? null : new Date().toISOString(),
          pause,
          counts: Object.fromEntries(Object.entries(totals).filter(([, v]) => v !== undefined)) as Record<string, number>,
        }).where(eq(schema.syncRuns.id, run.id)).run()

        if (pause) {
          log.event('info', null, `Paused: ${pause.message}. Progress is saved; resumes automatically at ${pause.resumeAt.slice(11, 16)} UTC`)
          update({ running: false, phase: 'paused', message: `${pause.message}. Progress is saved; continuing automatically.` })
          schedulePull(provider, pause.resumeAt)
        } else {
          // A staged change the service now already matches has nothing left to push.
          const dropped = pruneStaged()
          if (dropped) log.event('info', null, `${dropped} staged ${dropped === 1 ? 'change is' : 'changes are'} no longer needed and left the stage`)
          log.event('info', null, `Finished after ${run.attempts === 1 ? 'one attempt' : `${run.attempts} attempts`}. Main is up to date with ${name}; nothing was written to either service`)
          update({ running: false, phase: 'done', message: `Pulled ${name}. Nothing was written to either service.` })
        }
      })
      .catch((error: Error) => {
        console.error('[pull] failed', error)
        const stage = log.current()
        if (stage) log.stage(stage, { status: 'failed', detail: error.message })
        log.event('error', stage, `Stopped: ${error.message}. Everything fetched so far is saved; pulling again resumes from here`)
        log.flush()
        db.update(schema.syncRuns).set({ status: 'failed', error: error.message }).where(eq(schema.syncRuns.id, run.id)).run()
        update({ running: false, phase: 'failed', message: `The ${name} pull stopped. Progress is saved; pull again to resume.`, error: error.message })
      })
      .finally(() => release('pull'))
  } catch (error) {
    release('pull')
    throw error
  }
  return run.id
}

/**
 * Push what is staged for one service (docs/decisions/0007), in the background behind the same lock as pulls.
 * Returns the run ID, or null when another job is running. A push that stops partway is safe to run again: every
 * playlist is re-read and every write is idempotent.
 */
export function startPush(provider: ProviderId, writer: PushWriter): number | null {
  if (progress.running || !acquire('push')) return null
  const db = useDb()
  const name = providerNames[provider]
  try {
    const run = db.insert(schema.syncRuns).values({ kind: 'push', provider, trigger: 'manual', startedAt: new Date().toISOString(), status: 'running', attempts: 1, stages: {} }).returning().get()
    update({ running: true, phase: 'push', message: `Pushing to ${name}`, done: 0, total: 0, error: null, runId: run.id, provider, push: null })
    const log = createRunLog(run.id, () => update({ rev: progress.rev + 1 }))
    const start = requestCounts[provider]

    runPush(provider, writer, push => update({ push }), log)
      .then((counts) => {
        log.flush()
        const requests = { [`${provider}Requests`]: requestCounts[provider] - start }
        db.update(schema.syncRuns).set({ status: 'succeeded', finishedAt: new Date().toISOString(), counts: { ...counts, ...requests } }).where(eq(schema.syncRuns.id, run.id)).run()
        const summary = `${counts.added} added, ${counts.removed} removed${counts.failed ? `, ${counts.failed} failed and still staged` : ''}${counts.deferred ? `, ${counts.deferred} not looked up yet (lookup budget spent; push again)` : ''}${counts.skipped ? `, ${counts.skipped} waiting for playlist creation` : ''}`
        log.event(counts.failed ? 'warn' : 'info', null, `Finished: ${summary} on ${name}`)
        update({ running: false, phase: 'done', message: `Pushed to ${name}: ${summary}.` })
      })
      .catch((error: Error) => {
        console.error('[push] failed', error)
        // Record the cooldown so nothing is sent to the service before it clears (the push job may have already).
        if (error instanceof QuotaError) quotaPause(provider, error)
        const stage = log.current()
        if (stage) log.stage(stage, { status: 'failed', detail: error.message })
        log.event('error', stage, `Stopped: ${error.message}. What was written is recorded; the rest stays staged, and pushing again re-reads each playlist first`)
        log.flush()
        db.update(schema.syncRuns).set({ status: 'failed', finishedAt: new Date().toISOString(), error: error.message, counts: { [`${provider}Requests`]: requestCounts[provider] - start } }).where(eq(schema.syncRuns.id, run.id)).run()
        // Steps left running stopped with the push.
        const push = progress.push ? structuredClone(progress.push) : null
        for (const c of Object.values(push?.collections ?? {})) {
          for (const s of [c.add, c.remove]) if (s && (s.status === 'running' || s.status === 'waiting')) Object.assign(s, { status: 'failed', detail: s.status === 'running' ? error.message : 'Not attempted: the push stopped' })
        }
        const blocked = error instanceof QuotaError ? quotaBlockedUntil(provider) : null
        const message = blocked
          ? `The push to ${name} stopped: ${name}'s quota is used up until ${blocked.slice(11, 16)} UTC${blocked.slice(0, 10) === new Date().toISOString().slice(0, 10) ? '' : ` on ${blocked.slice(0, 10)}`}. What was written is recorded and the rest stays staged`
          : `The push to ${name} stopped: ${error.message}`
        update({ running: false, phase: 'failed', message, error: error.message, push })
      })
      .finally(() => release('push'))
    return run.id
  } catch (error) {
    release('push')
    throw error
  }
}
