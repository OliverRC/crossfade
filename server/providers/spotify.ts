// Spotify Web API adapter (read side). Endpoints per the February and March 2026 changelogs.
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { getAccessToken } from '../utils/accounts'
import { chunk, createClient, ProviderError } from './http'
import { lookupIsrcs, SEARCH_LIMIT, type OrMode } from './spotify-isrc'
import type { MusicProvider, PlaylistEntry, PushWriter, WriteFailures } from './types'

export function toSpotifyTrack(t: any): ProviderTrack | null {
  if (!t || t.type !== 'track' || t.is_local || !t.id) return null
  // A track Spotify has pulled from its catalogue is still listed, but with no name, artist, ISRC or duration.
  const pulled = !t.name && !t.duration_ms
  return {
    ...(pulled ? { available: false } : {}),
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

    async getPlaylists() {
      // Spotify only returns the songs of playlists you own or collaborate on; the rest are listed as followed.
      const playlists = await pages<any>('/me/playlists?limit=50')
      return playlists.filter(p => p?.id).map((p): ProviderPlaylist => {
        if (p.owner?.id === userId) return { providerCollectionId: p.id, name: p.name, access: 'owned' }
        return { providerCollectionId: p.id, name: p.name, access: p.collaborative ? 'collaborative' : 'followed', ownerName: p.owner?.display_name ?? p.owner?.id ?? null }
      })
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

const uri = (id: string) => `spotify:track:${id}`

/**
 * Push to Spotify (docs/decisions/0007). Writes per the February 2026 changelog, tried against the real account in the
 * M0 spike: playlist adds `POST /playlists/{id}/items` with `{ uris }`, removals `DELETE` the same path with
 * `{ items: [{ uri }] }` (every occurrence goes), liked songs `PUT` and `DELETE /me/library?uris=…`, 40 per request.
 * Lookups are search requests, rationed per push because the Development Mode quota is unpublished.
 */
export function createSpotifyWriter(lookupBudget: number): PushWriter {
  const request = createClient('spotify', 'https://api.spotify.com/v1', () => getAccessToken('spotify'))

  /** A batch Spotify refuses outright (bad ID, 4xx) fails each of its songs; rate limits and server errors stop the push. */
  async function each(ids: string[], size: number, send: (batch: string[]) => Promise<unknown>): Promise<WriteFailures> {
    const failures: WriteFailures = new Map()
    for (const batch of chunk(ids, size)) {
      try {
        await send(batch)
      } catch (error) {
        if (!(error instanceof ProviderError) || error.status === 429 || error.status >= 500) throw error
        for (const id of batch) failures.set(id, error.message)
      }
    }
    return failures
  }

  return {
    id: 'spotify',
    isrcBatchSize: 5,
    lookupBudget,

    async findPlayableByIsrcs(isrcs) {
      const { tracks, requests } = await lookupIsrcs(isrcs, async (q) => {
        const res = await request('/search', { query: { q, type: 'track', limit: SEARCH_LIMIT } })
        return (res.tracks?.items ?? []).map(toSpotifyTrack).filter((t: ProviderTrack | null): t is ProviderTrack => t !== null && t.available !== false)
      }, orState)
      // Any result is the same recording; the first is Spotify's most relevant.
      const found = new Map([...tracks].filter(([, ts]) => ts.length).map(([isrc, ts]) => [isrc, ts[0]!.providerTrackId]))
      return { found, requests }
    },

    async readPlaylist(playlistId) {
      try {
        const entries: PlaylistEntry[] = []
        let next: string | null = `/playlists/${playlistId}/items?limit=50`
        while (next) {
          const page: any = await request(next)
          for (const e of page.items ?? []) {
            const t = toSpotifyTrack(e.item ?? e.track)
            if (t) entries.push({ trackId: t.providerTrackId, entryId: null, isrc: t.isrc })
          }
          next = page.next
        }
        return entries
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null
        throw error
      }
    },

    addToPlaylist: (playlistId, ids) => each(ids, 100, batch =>
      request(`/playlists/${playlistId}/items`, { method: 'POST', body: { uris: batch.map(uri) } })),

    // Removing a URI removes every occurrence, so each song is named once.
    removeFromPlaylist: (playlistId, entries) => each([...new Set(entries.map(e => e.trackId))], 100, batch =>
      request(`/playlists/${playlistId}/items`, { method: 'DELETE', body: { items: batch.map(id => ({ uri: uri(id) })) } })),

    addLiked: ids => each(ids, 40, batch => request('/me/library', { method: 'PUT', query: { uris: batch.map(uri).join(',') } })),
    removeLiked: ids => each(ids, 40, batch => request('/me/library', { method: 'DELETE', query: { uris: batch.map(uri).join(',') } })),
  }
}
