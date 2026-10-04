// Pull: fold one service's changes to one collection into main. Pure, no I/O. See docs/decisions/0005.
// The service's snapshot from its last pull is the base: absent → present is an add, present → absent a removal.
import type { ProviderId } from '../../shared/types'

export interface MainEntry {
  state: 'active' | 'removed'
  changedAt: string
  changedBy: ProviderId | 'user'
}

export interface PullInput {
  provider: ProviderId
  /** Canonical songs the service holds in the collection now, unavailable ones included. */
  now: Set<number>
  /** The service's snapshot from its last pull; null on the first pull of this collection. */
  base: { items: Set<number>, takenAt: string } | null
  /** Main's memberships for the collection. */
  main: Map<number, MainEntry>
  /** Oliver confirmed the removals the sanity guard held back. */
  acceptRemovals?: boolean
}

export type PullChange =
  | { kind: 'add', canonicalTrackId: number }
  | { kind: 'remove', canonicalTrackId: number }
  /**
   * The service newly holds a song main already has: main records that this service confirmed it, so a later
   * removal on the other service that predates it is a conflict rather than silently undoing this add.
   */
  | { kind: 'confirm', canonicalTrackId: number }
  /** The service's change would undo a newer change in main: stop and ask. */
  | { kind: 'conflict', canonicalTrackId: number, change: 'added' | 'removed' }

export interface PullHold {
  reason: 'empty' | 'mass_removal'
  before: number
  removing: number
}

export interface PullResult {
  /** Empty when held. */
  changes: PullChange[]
  hold: PullHold | null
}

/** Sanity guard: a read that loses more than this share of a collection, and at least MIN_REMOVALS songs, is held. */
export const MAX_REMOVAL_SHARE = 0.1
export const MIN_REMOVALS = 5

export function pull(input: PullInput): PullResult {
  const { provider, now, base, main } = input
  const before = base?.items ?? new Set<number>()
  const added = [...now].filter(id => !before.has(id))
  const removed = [...before].filter(id => !now.has(id))

  if (base && !input.acceptRemovals) {
    if (before.size > 0 && now.size === 0) return { changes: [], hold: { reason: 'empty', before: before.size, removing: before.size } }
    if (removed.length >= MIN_REMOVALS && removed.length / before.size > MAX_REMOVAL_SHARE) {
      return { changes: [], hold: { reason: 'mass_removal', before: before.size, removing: removed.length } }
    }
  }

  // Main changed this song after the service's base, and something other than this service changed it.
  const newer = (e: MainEntry) => e.changedBy !== provider && (!base || e.changedAt > base.takenAt)
  const changes: PullChange[] = []
  for (const id of added) {
    const e = main.get(id)
    if (!e) changes.push({ kind: 'add', canonicalTrackId: id })
    // A first pull only lines the service up with main; it confirms nothing.
    else if (e.state === 'active') { if (base) changes.push({ kind: 'confirm', canonicalTrackId: id }) }
    else if (e.state === 'removed') changes.push(newer(e) ? { kind: 'conflict', canonicalTrackId: id, change: 'added' } : { kind: 'add', canonicalTrackId: id })
  }
  for (const id of removed) {
    const e = main.get(id)
    if (e?.state !== 'active') continue
    changes.push(newer(e) ? { kind: 'conflict', canonicalTrackId: id, change: 'removed' } : { kind: 'remove', canonicalTrackId: id })
  }
  return { changes, hold: null }
}
