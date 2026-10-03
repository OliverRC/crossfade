// Spotify Web API adapter (read side). Endpoints per the February and March 2026 changelogs.
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { getAccessToken } from '../utils/accounts'
import { createClient } from './http'
import { lookupIsrcs, SEARCH_LIMIT, type OrMode } from './spotify-isrc'
import type { MusicProvider } from './types'

export function toSpotifyTrack(t: any): ProviderTrack | null {
  if (!t || t.type !== 'track' || t.is_local || !t.id) return null
  return {
    providerTrackId: t.id,
    isrc: t.external_ids?.isrc?.toUpperCase() ?? null,
    title: t.name,
    artists: (t.artists ?? []).map((a: any) => a.name),
    album: t.album?.name ?? '',
    durationMs: t.duration_ms ?? 0,
    explicit: Boolean(t.explicit),
    version: null, // Spotify puts version tags in the title; normalisation splits them out
  }
}

/** Whether Spotify search honours OR between isrc: filters, learned once per server process. */
const orState: { mode: OrMode } = { mode: 'unknown' }

export function createSpotify(userId: string): MusicProvider {
  const request = createClient('spotify', 'https://api.spotify.com/v1', () => getAccessToken('spotify'))

  async function pages<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let next: string | null = path
    while (next) {
      const page: any = await request(next)
      items.push(...page.items)
      next = page.next
    }
    return items
  }

  const tracksOf = (entries: any[]) => entries.map(e => toSpotifyTrack(e.item ?? e.track)).filter((t): t is ProviderTrack => t !== null)

  return {
    id: 'spotify',
    isrcBatchSize: 5,

    async getLikedTracks() {
      return tracksOf(await pages('/me/tracks?limit=50'))
    },

    async getOwnedPlaylists() {
      const playlists = await pages<any>('/me/playlists?limit=50')
      return playlists
        .filter(p => p?.owner?.id === userId)
        .map((p): ProviderPlaylist => ({ providerCollectionId: p.id, name: p.name }))
    },

    async getPlaylistTracks(playlistId) {
      return tracksOf(await pages(`/playlists/${playlistId}/items?limit=50`))
    },

    findByIsrcs(isrcs) {
      return lookupIsrcs(isrcs, async (q) => {
        const res = await request('/search', { query: { q, type: 'track', limit: SEARCH_LIMIT } })
        return (res.tracks?.items ?? []).map(toSpotifyTrack).filter((t: ProviderTrack | null): t is ProviderTrack => t !== null)
      }, orState)
    },

    lookupMode() {
      if (orState.mode === 'supported') return 'Spotify search accepts OR: looking up 5 ISRCs per request'
      if (orState.mode === 'unsupported') return 'Spotify search ignores OR: looking up one ISRC per request'
      return null
    },

    async search(query) {
      const res = await request('/search', { query: { q: query, type: 'track', limit: 10 } })
      return (res.tracks?.items ?? []).map(toSpotifyTrack).filter((t: ProviderTrack | null): t is ProviderTrack => t !== null)
    },
  }
}
