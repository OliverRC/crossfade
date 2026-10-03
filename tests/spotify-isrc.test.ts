import { describe, expect, it } from 'vitest'
import type { ProviderTrack } from '../shared/types'
import { lookupIsrcs, SEARCH_LIMIT, type OrMode, type SearchFn } from '../server/providers/spotify-isrc'

const track = (isrc: string, n = 0): ProviderTrack =>
  ({ providerTrackId: `${isrc}-${n}`, isrc, title: isrc, artists: ['A'], album: 'B', durationMs: 1, explicit: false, version: null })

/** A fake Spotify search over a catalogue, with or without OR support. */
function spotify(catalogue: ProviderTrack[], orWorks: boolean): { search: SearchFn, queries: string[] } {
  const queries: string[] = []
  const search: SearchFn = async (q) => {
    queries.push(q)
    const wanted = q.split(' OR ').map(s => s.replace('isrc:', ''))
    // Without OR support, Spotify reads "OR" as a keyword and matches nothing.
    if (wanted.length > 1 && !orWorks) return []
    return catalogue.filter(t => wanted.includes(t.isrc!)).slice(0, SEARCH_LIMIT)
  }
  return { search, queries }
}

const isrcs = Array.from({ length: 10 }, (_, i) => `ISRC${i}`)

describe('Spotify ISRC lookup', () => {
  it('batches five ISRCs per request once OR proves to work', async () => {
    const { search, queries } = spotify(isrcs.slice(0, 8).map(i => track(i)), true)
    const state = { mode: 'unknown' as OrMode }
    const { tracks, requests } = await lookupIsrcs(isrcs, search, state)
    expect(state.mode).toBe('supported')
    expect(requests).toBe(2)
    expect(queries[0]).toBe('isrc:ISRC0 OR isrc:ISRC1 OR isrc:ISRC2 OR isrc:ISRC3 OR isrc:ISRC4')
    expect([...tracks.values()].filter(t => t.length)).toHaveLength(8)
    expect(tracks.get('ISRC9')).toEqual([])
  })

  it('detects that OR does not work, then looks up one ISRC per request', async () => {
    const { search, queries } = spotify(isrcs.map(i => track(i)), false)
    const state = { mode: 'unknown' as OrMode }
    const { tracks, requests } = await lookupIsrcs(isrcs, search, state)
    expect(state.mode).toBe('unsupported')
    expect([...tracks.values()].every(t => t.length === 1)).toBe(true)
    // One wasted batch, then one request per ISRC.
    expect(requests).toBe(1 + 10)
    expect(queries.filter(q => q.includes(' OR '))).toHaveLength(1)
  })

  it('re-checks ISRCs that a full page of results may have crowded out', async () => {
    // ISRC0 has 9 releases, so a five-ISRC batch fills all 10 results.
    const catalogue = [...Array.from({ length: 9 }, (_, n) => track('ISRC0', n)), ...isrcs.slice(1, 5).map(i => track(i))]
    const { search } = spotify(catalogue, true)
    const state = { mode: 'supported' as OrMode }
    const { tracks } = await lookupIsrcs(isrcs.slice(0, 5), search, state)
    expect(isrcs.slice(0, 5).every(i => tracks.get(i)!.length > 0)).toBe(true)
  })

  it('never keeps a result whose ISRC was not asked for', async () => {
    const search: SearchFn = async () => [track('SOMETHING-ELSE')]
    const { tracks } = await lookupIsrcs(['ISRC0'], search, { mode: 'unknown' })
    expect(tracks.get('ISRC0')).toEqual([])
  })
})
