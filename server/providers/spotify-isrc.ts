// Spotify has no batch ISRC lookup (Get Several Tracks was removed in February 2026), only search.
// Search may accept `isrc:A OR isrc:B`; the operator is no longer documented, so this learns it:
// it tries batches, and every result is verified by ISRC, so a wrong guess costs requests, never a wrong link.
import type { ProviderTrack } from '../../shared/types'

/** One search request: returns at most `SEARCH_LIMIT` tracks. */
export type SearchFn = (query: string) => Promise<ProviderTrack[]>
export type OrMode = 'unknown' | 'supported' | 'unsupported'

export const SEARCH_LIMIT = 10
/** ISRCs per OR query; leaves room in 10 results for an ISRC released on several albums. */
export const OR_BATCH = 5

export interface IsrcLookup {
  tracks: Map<string, ProviderTrack[]>
  requests: number
}

export async function lookupIsrcs(isrcs: string[], search: SearchFn, state: { mode: OrMode }): Promise<IsrcLookup> {
  const tracks = new Map<string, ProviderTrack[]>(isrcs.map(i => [i, []]))
  let requests = 0
  const run = async (query: string) => { requests++; return search(query) }
  const collect = (results: ProviderTrack[], wanted: Set<string>) => {
    for (const t of results) if (t.isrc && wanted.has(t.isrc)) tracks.get(t.isrc)!.push(t)
  }
  const single = async (isrc: string) => {
    collect(await run(`isrc:${isrc}`), new Set([isrc]))
    return tracks.get(isrc)!.length > 0
  }

  const queue = [...new Set(isrcs)]
  while (queue.length) {
    if (state.mode === 'unsupported' || queue.length === 1) {
      await single(queue.shift()!)
      continue
    }

    const batch = queue.splice(0, OR_BATCH)
    const results = await run(batch.map(i => `isrc:${i}`).join(' OR '))
    collect(results, new Set(batch))
    const missing = batch.filter(i => !tracks.get(i)!.length)
    if (batch.length - missing.length >= 2) state.mode = 'supported'
    const saturated = results.length >= SEARCH_LIMIT

    if (state.mode === 'supported') {
      // A full page may have crowded some ISRCs out; anything missing from a partial page is not on Spotify.
      if (saturated) for (const i of missing) await single(i)
      continue
    }

    // Unknown: the batch found at most one ISRC, which proves nothing. Check the rest one by one.
    for (const i of missing) {
      if (await single(i) && !saturated) {
        // An unsaturated OR query missed a track that exists: the operator does not work.
        state.mode = 'unsupported'
      }
    }
  }

  return { tracks, requests }
}
