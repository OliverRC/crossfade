// Status: how each service compares with main, song by song, for one collection. Pure, no I/O.
// What a service is missing is what a push would add there; what it holds that main removed, a push would remove.
import { PROVIDERS, type ProviderId, type RowState, type SideState, type StatusCounts } from '../../shared/types'
import type { MainEntry } from './pull'

export interface StatusSide {
  /** The service has been pulled at least once. */
  pulled: boolean
  /** Songs in this collection on the service at its last pull, mapped to whether it still offers them. Null when the collection is not on the service. */
  items: Map<number, boolean> | null
  /** The service has this collection as someone else's playlist it will not let us read: nothing to compare or push. */
  followed?: boolean
}

export interface StatusInput {
  main: Map<number, MainEntry>
  sides: Record<ProviderId, StatusSide>
  /** Songs with an open conflict, and which service's pull raised it. */
  conflicts: Map<number, { provider: ProviderId, change: 'added' | 'removed' }>
}

export interface StatusRow {
  canonicalTrackId: number
  main: 'active' | 'removed'
  conflict: { provider: ProviderId, change: 'added' | 'removed' } | null
  spotify: SideState
  tidal: SideState
}

function sideState(entry: MainEntry, side: StatusSide, id: number): SideState {
  if (!side.pulled) return 'unknown'
  if (side.followed) return 'followed'
  const available = side.items?.get(id)
  if (entry.state === 'active') {
    if (available === undefined) return 'missing'
    return available ? 'present' : 'unavailable'
  }
  return available === undefined ? 'absent' : 'extra'
}

const RANK: Record<SideState, number> = { missing: 1, extra: 1, unavailable: 2, unknown: 3, present: 4, absent: 4, followed: 4 }

export function status(input: StatusInput): { rows: StatusRow[], counts: StatusCounts } {
  const zero = () => ({ spotify: 0, tidal: 0 })
  const counts: StatusCounts = { inSync: 0, conflicts: 0, add: zero(), remove: zero(), unavailable: zero() }
  const rows: StatusRow[] = []

  for (const [id, entry] of input.main) {
    const row: StatusRow = {
      canonicalTrackId: id,
      main: entry.state,
      conflict: input.conflicts.get(id) ?? null,
      spotify: sideState(entry, input.sides.spotify, id),
      tidal: sideState(entry, input.sides.tidal, id),
    }
    // A song removed from main and gone from both services is settled history, not a row.
    if (!row.conflict && row.spotify !== 'extra' && row.tidal !== 'extra' && entry.state === 'removed') continue
    rows.push(row)

    if (row.conflict) { counts.conflicts++; continue }
    for (const p of PROVIDERS) {
      if (row[p] === 'missing') counts.add[p]++
      if (row[p] === 'extra') counts.remove[p]++
      if (row[p] === 'unavailable') counts.unavailable[p]++
    }
    if (PROVIDERS.every(p => row[p] === 'present' || row[p] === 'followed')) counts.inSync++
  }

  const rank = (r: StatusRow) => (r.conflict ? 0 : Math.min(RANK[r.spotify], RANK[r.tidal]))
  rows.sort((a, b) => rank(a) - rank(b))
  return { rows, counts }
}

/** One state per row for the Library page: a conflict first, then pending removals, adds, unavailable, unknown. */
export function rowState(row: StatusRow): RowState {
  if (row.conflict) return 'conflict'
  // A followed side cannot be compared, so the row's state comes from the services that can.
  const sides = PROVIDERS.map(p => row[p]).filter(s => s !== 'followed')
  if (sides.includes('extra')) return 'remove'
  if (sides.includes('missing')) return 'add'
  if (sides.includes('unavailable')) return 'unavailable'
  if (sides.includes('unknown')) return 'unknown'
  return 'in_sync'
}
