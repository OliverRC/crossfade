// Metadata matching (docs/decisions/0008). Pure functions, no I/O.
// ISRC comes first. Songs the ISRC did not join are the same song when their cleaned-up title and version are equal,
// their artists agree and their lengths are within 2 seconds, but only across services: two copies only one service
// holds stay apart, because a service keeping them apart (a demo and a re-recording, clean and explicit) usually
// means they differ.
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

/** Joining words a service leaves on an artist name, as in Spotify's "Bazzi vs.". */
const TRAILING_CONNECTOR = /\s+(vs|x|and|feat|ft|featuring|with)$/

export function cleanArtist(name: string): string {
  let s = normaliseText(name)
  while (TRAILING_CONNECTOR.test(s)) s = s.replace(TRAILING_CONNECTOR, '')
  return s
}

/** Title base and version, cleaned up. Null when the title is empty. */
export function titleKey(title: string, version: string | null): string | null {
  const s = splitTitle(title, version)
  return s.base ? `${s.base} | ${s.version ?? ''}` : null
}

function artistSet(song: MatchSong): Set<string> {
  return new Set([...song.artists.map(cleanArtist), ...splitTitle(song.title, song.version).featured.map(cleanArtist)].filter(Boolean))
}

/**
 * The same artists, allowing for one service crediting someone the other names only in the title: Tidal's "Mine
 * (Bazzi vs. Eden Prince Remix)" by Bazzi is Spotify's "Mine - Bazzi vs. Eden Prince Remix" by Bazzi and Eden Prince.
 * At least one artist must be credited on both.
 */
export function artistsAgree(a: MatchSong, b: MatchSong): boolean {
  const sa = artistSet(a)
  const sb = artistSet(b)
  if (![...sa].some(x => sb.has(x))) return false
  const named = (artist: string, song: MatchSong) => ` ${normaliseText(`${song.title} ${song.version ?? ''}`)} `.includes(` ${artist} `)
  return [...sa].every(x => sb.has(x) || named(x, b)) && [...sb].every(x => sa.has(x) || named(x, a))
}

export interface MetadataMerge {
  /** The song that stays: the one on most services, then the oldest. */
  keep: number
  /** Songs folded into it. */
  merge: number[]
}

/** Groups of songs that are one song by metadata, across services. */
export function metadataMerges(songs: MatchSong[]): MetadataMerge[] {
  const byTitle = new Map<string, MatchSong[]>()
  for (const s of songs) {
    const key = titleKey(s.title, s.version)
    if (key) byTitle.set(key, [...byTitle.get(key) ?? [], s])
  }
  const out: MetadataMerge[] = []
  for (const group of byTitle.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.durationMs - b.durationMs || a.id - b.id)
    // Every song in a cluster is within 2 seconds of its shortest, so lengths never drift along a chain.
    for (let i = 0; i < group.length;) {
      let j = i + 1
      while (j < group.length && group[j]!.durationMs - group[i]!.durationMs <= METADATA_DURATION_MS) j++
      const cluster = group.slice(i, j)
      i = j
      for (const same of byArtists(cluster)) {
        // Two copies only one service holds are ambiguous: which of them is the other service's song? Neither joins.
        const only = (s: MatchSong) => (s.providers.length === 1 ? s.providers[0] : null)
        const joinable = same.filter(s => !only(s) || same.filter(o => only(o) === only(s)).length === 1)
        if (joinable.length < 2 || new Set(joinable.flatMap(s => s.providers)).size < 2) continue
        const [keep, ...rest] = [...joinable].sort((a, b) => b.providers.length - a.providers.length || a.id - b.id)
        out.push({ keep: keep!.id, merge: rest.map(s => s.id) })
      }
    }
  }
  return out
}

/** Split songs into groups whose artists agree, joining any two that agree. */
function byArtists(songs: MatchSong[]): MatchSong[][] {
  const parent = songs.map((_, i) => i)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)))
  for (let a = 0; a < songs.length; a++) {
    for (let b = a + 1; b < songs.length; b++) if (artistsAgree(songs[a]!, songs[b]!)) parent[root(b)] = root(a)
  }
  const groups = new Map<number, MatchSong[]>()
  songs.forEach((s, i) => groups.set(root(i), [...groups.get(root(i)) ?? [], s]))
  return [...groups.values()]
}
