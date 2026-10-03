// Duplicate playlists on one service: copies share a normalised name and are compared item by item.
// Pure functions, no I/O. See docs/decisions/0004.
import { normaliseText } from './normalise'

/** Exact copies: the items every copy shares make up at least this share of the largest copy. */
export const EXACT_SHARE = 0.9
/** One copy contains the rest: every copy has at least this share of its items in the largest copy. */
export const CONTAINED_SHARE = 0.9

/** A playlist as a list of item keys (`tracks:123`, `videos:456`), in playlist order. */
export interface PlaylistItems {
  id: string
  name: string
  items: string[]
}

/**
 * exact: copies of the same playlist (tier 1, merged by cleanup).
 * contained: the largest copy holds at least 90% of every other copy (tier 2, shown only).
 * different: same name, different contents (tier 3, shown only).
 */
export type DuplicateTier = 'exact' | 'contained' | 'different'

export interface DuplicateGroup {
  name: string
  tier: DuplicateTier
  /** Largest first: the default copy to keep. Ties keep the service's own order. */
  copies: PlaylistItems[]
  /** Items in every copy. */
  shared: number
  /** Distinct items across all copies: the size of the merged playlist. */
  union: number
}

export interface DuplicateReport {
  /** Playlists with no items, offered for removal whatever their name. */
  empty: PlaylistItems[]
  groups: DuplicateGroup[]
}

const TIER_ORDER: Record<DuplicateTier, number> = { exact: 0, contained: 1, different: 2 }

export function findDuplicates(playlists: PlaylistItems[]): DuplicateReport {
  const empty = playlists.filter(p => p.items.length === 0)
  const byName = new Map<string, PlaylistItems[]>()
  for (const p of playlists) {
    if (!p.items.length) continue
    const key = normaliseText(p.name)
    byName.set(key, [...byName.get(key) ?? [], p])
  }
  const groups = [...byName.values()].filter(copies => copies.length > 1).map(groupOf)
  groups.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name))
  return { empty, groups }
}

function groupOf(input: PlaylistItems[]): DuplicateGroup {
  const copies = [...input].sort((a, b) => new Set(b.items).size - new Set(a.items).size)
  const sets = copies.map(c => new Set(c.items))
  const largest = sets[0]!
  const shared = [...largest].filter(i => sets.every(s => s.has(i))).length
  const union = new Set(copies.flatMap(c => c.items)).size
  const tier: DuplicateTier = shared / largest.size >= EXACT_SHARE
    ? 'exact'
    : sets.every(s => [...s].filter(i => largest.has(i)).length / s.size >= CONTAINED_SHARE) ? 'contained' : 'different'
  return { name: copies[0]!.name, tier, copies, shared, union }
}

export interface MergePlan {
  keeper: PlaylistItems
  spares: PlaylistItems[]
  /** Items the keeper lacks, in the order they appear across the spares. */
  add: string[]
  /** Every distinct item across all copies: the keeper must hold all of these before a spare is deleted. */
  union: string[]
}

export function mergePlan(copies: PlaylistItems[], keeperId: string): MergePlan {
  const keeper = copies.find(c => c.id === keeperId)
  if (!keeper) throw new Error(`Playlist ${keeperId} is not one of the copies`)
  const spares = copies.filter(c => c !== keeper)
  const union = [...new Set([...keeper.items, ...spares.flatMap(s => s.items)])]
  return { keeper, spares, add: missingFrom(keeper.items, union), union }
}

/** Items of `expected` that `present` lacks. */
export function missingFrom(present: string[], expected: string[]): string[] {
  const have = new Set(present)
  return [...new Set(expected)].filter(i => !have.has(i))
}
