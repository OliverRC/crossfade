// One job at a time: a sync and a playlist cleanup never overlap, because cleanup edits what a sync reads.
export type Job = 'sync' | 'cleanup'

let holder: Job | null = null

export const lockHolder = () => holder

export function acquire(job: Job): boolean {
  if (holder) return false
  holder = job
  return true
}

export function release(job: Job) {
  if (holder === job) holder = null
}
