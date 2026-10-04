// Spotify track objects as the API returns them, mapped to ProviderTrack.
import { describe, expect, it } from 'vitest'
import { toSpotifyTrack } from '../server/providers/spotify'

const track = (over: Record<string, unknown> = {}) => ({
  type: 'track', id: 'sp1', name: 'One', artists: [{ name: 'Metallica' }], album: { name: '...And Justice for All' },
  duration_ms: 446_000, explicit: false, external_ids: { isrc: 'usel18800005' }, ...over,
})

describe('toSpotifyTrack', () => {
  it('maps a playable track, ISRC upper-cased', () => {
    expect(toSpotifyTrack(track())).toEqual({
      providerTrackId: 'sp1', isrc: 'USEL18800005', title: 'One', artists: ['Metallica'], album: '...And Justice for All',
      durationMs: 446_000, explicit: false, version: null,
    })
  })

  it('marks a track Spotify pulled from its catalogue as unavailable: still listed, with no name or duration', () => {
    const pulled = toSpotifyTrack(track({ name: '', artists: [{ name: '' }], album: { name: '' }, duration_ms: 0, external_ids: {} }))
    expect(pulled).toMatchObject({ providerTrackId: 'sp1', available: false, isrc: null })
  })

  it('skips local files and episodes', () => {
    expect(toSpotifyTrack(track({ is_local: true }))).toBeNull()
    expect(toSpotifyTrack(track({ type: 'episode' }))).toBeNull()
  })
})
