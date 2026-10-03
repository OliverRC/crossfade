// V0 bootstrap diff for one collection: what a union merge would do. Pure, no I/O.
// Snapshot-based three-way diffing (removals, conflicts) arrives in M4.
import type { LinkMethod, LinkStatus, ProviderId, RowState, UnmatchedReason } from '../../shared/types'

export interface LinkInfo {
  status: LinkStatus
  method?: LinkMethod
  confidence?: number
  reason?: UnmatchedReason
}

export interface DiffInput {
  /** Canonical track IDs present on each side; null when the collection does not exist there. */
  spotify: Set<number> | null
  tidal: Set<number> | null
  /** The canonical track's preferred link on a provider, if any. */
  linkOn: (canonicalTrackId: number, provider: ProviderId) => LinkInfo | undefined
}

export interface PlannedRow {
  canonicalTrackId: number
  state: RowState
  target?: ProviderId
  link?: LinkInfo
}

const ORDER: Record<RowState, number> = { review: 0, add: 1, pending: 2, unmatched: 3, in_sync: 4 }

export function diffCollection(input: DiffInput): PlannedRow[] {
  const onSpotify = input.spotify ?? new Set<number>()
  const onTidal = input.tidal ?? new Set<number>()
  const rows: PlannedRow[] = []

  for (const id of new Set([...onSpotify, ...onTidal])) {
    if (onSpotify.has(id) && onTidal.has(id)) {
      rows.push({ canonicalTrackId: id, state: 'in_sync' })
      continue
    }
    const target: ProviderId = onSpotify.has(id) ? 'tidal' : 'spotify'
    const link = input.linkOn(id, target)
    rows.push({ canonicalTrackId: id, state: stateFor(link), target, link })
  }

  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state])
}

function stateFor(link: LinkInfo | undefined): RowState {
  switch (link?.status) {
    case 'matched': return 'add'
    case 'review': return 'review'
    case undefined: return 'pending' // not looked up yet (quota, budget, or a run still in progress)
    default: return 'unmatched'
  }
}
