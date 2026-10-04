// Metadata matching (docs/decisions/0008). Pure functions, no I/O.
// ISRC comes first. Songs the ISRC did not join are the same song when their cleaned-up title, artists and version are
// equal and their lengths are within 2 seconds, but only across services: two copies only one service holds stay apart,
// because a service keeping them apart (a demo and a re-recording, clean and explicit) usually means they differ.
import type { ProviderId } from '../../shared/types'
import { normaliseText, splitTitle } from './normalise'

export const METADATA_DURATION_MS = 2000

export interface MatchSong {
  id: number
  title: string
  version: string | null
  artists: string[]
  durationMs: number
  /** Services holding a copy of the song. */
  providers: ProviderId[]
}

/** Title base, artists (featured ones included) and version, cleaned up. Null when the title or artists are empty. */
export function metadataKey(title: string, version: string | null, artists: string[]): string | null {
  const s = splitTitle(title, version)
  const names = [...new Set([...artists.map(normaliseText), ...s.featured])].filter(Boolean).sort()
  if (!s.base || !names.length) return null
  return [s.base, names.join(', '), s.version ?? ''].join(' | ')
}

export interface MetadataMerge {
  /** The song that stays: the one on most services, then the oldest. */
  keep: number
  /** Songs folded into it. */
  merge: number[]
}

/** Groups of songs that are one song by metadata, across services. */
export function metadataMerges(songs: MatchSong[]): MetadataMerge[] {
  const byKey = new Map<string, MatchSong[]>()
  for (const s of songs) {
    const key = metadataKey(s.title, s.version, s.artists)
    if (key) byKey.set(key, [...byKey.get(key) ?? [], s])
  }
  const out: MetadataMerge[] = []
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.durationMs - b.durationMs || a.id - b.id)
    // Every song in a cluster is within 2 seconds of its shortest, so lengths never drift along a chain.
    for (let i = 0; i < group.length;) {
      let j = i + 1
      while (j < group.length && group[j]!.durationMs - group[i]!.durationMs <= METADATA_DURATION_MS) j++
      // Two copies only one service holds are ambiguous: which of them is the other service's song? Neither joins.
      const only = (s: MatchSong) => (s.providers.length === 1 ? s.providers[0] : null)
      const cluster = group.slice(i, j).filter(s => !only(s) || group.slice(i, j).filter(o => only(o) === only(s)).length === 1)
      i = j
      if (cluster.length < 2 || new Set(cluster.flatMap(s => s.providers)).size < 2) continue
      const [keep, ...rest] = [...cluster].sort((a, b) => b.providers.length - a.providers.length || a.id - b.id)
      out.push({ keep: keep!.id, merge: rest.map(s => s.id) })
    }
  }
  return out
}
