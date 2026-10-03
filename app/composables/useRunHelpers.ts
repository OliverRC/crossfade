import type { RunSummary, StageState } from '~~/shared/types'
import { STAGES } from '~~/shared/types'

export const runStatusPill: Record<RunSummary['status'], { label: string, cls: string }> = {
  running: { label: 'Running', cls: 'solid-mint' },
  paused: { label: 'Paused', cls: 'solid-amber' },
  failed: { label: 'Stopped', cls: 'solid-coral' },
  succeeded: { label: 'Finished', cls: '' },
}

/** Overall progress: finished stages count fully, the running one by its done/total. */
export function runProgress(run: RunSummary): number {
  let sum = 0
  for (const { key } of STAGES) {
    const s = run.stages[key]
    if (!s) continue
    if (s.status === 'done' || s.status === 'skipped') sum += 1
    else if (s.total) sum += Math.min(1, s.done / s.total)
  }
  return sum / STAGES.length
}

/** The stage that is running, or the one a paused or stopped run is stuck on. */
export function activeStage(run: RunSummary) {
  return STAGES.find(({ key }) => ['running', 'paused', 'failed'].includes(run.stages[key]?.status ?? ''))
}

export function stageDuration(s: StageState, now: number): string | null {
  if (!s.startedAt) return null
  const ms = (s.finishedAt ? Date.parse(s.finishedAt) : now) - Date.parse(s.startedAt)
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : formatSpan(ms)
}

/** "11:05:25" in UTC, for log lines. */
export const clock = (iso: string) => iso.slice(11, 19)
