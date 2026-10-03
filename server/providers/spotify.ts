// Spotify Web API adapter (read side). Endpoints per the February and March 2026 changelogs.
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { getAccessToken } from '../utils/accounts'
import { createClient } from './http'
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

    async findByIsrcs(isrcs) {
      const out = new Map<string, ProviderTrack[]>()
      for (const isrc of isrcs) {
        const res = await request('/search', { query: { q: `isrc:${isrc}`, type: 'track', limit: 10 } })
        out.set(isrc, (res.tracks?.items ?? []).map(toSpotifyTrack).filter(Boolean))
      }
      return out
    },

    async search(query) {
      const res = await request('/search', { query: { q: query, type: 'track', limit: 10 } })
      return (res.tracks?.items ?? []).map(toSpotifyTrack).filter(Boolean)
    },
  }
}
