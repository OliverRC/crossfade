// One job at a time, in-process, never inside a request handler. Progress is broadcast for SSE.
// A pull reads one service into main (docs/decisions/0005). An unfinished pull (paused, failed, or interrupted
// by a restart) is resumed rather than restarted, and a paused one resumes on its own.
import { EventEmitter } from 'node:events'
import { and, desc, eq } from 'drizzle-orm'
import type { ProviderId, RunProgress } from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import { schema, useDb } from '../utils/db'
import { acquire, lockHolder, release } from './lock'
import { runPull } from './pull'
import { pruneStaged } from '../utils/staging'
import { providerNames } from './quota'
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

/** Start or resume a pull of one service unless a job is running. Returns the run ID, or null when skipped. */
export function startPull(provider: ProviderId, trigger: 'manual' | 'schedule' = 'manual'): number | null {
  if (progress.running || !acquire('pull')) return null
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
    update({ running: true, phase: 'start', message: resumable ? `Resuming the ${name} pull` : `Pulling ${name}`, done: 0, total: 0, error: null, resumeAt: null, runId: run.id, provider })
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
