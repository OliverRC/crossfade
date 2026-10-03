// Tidal Open API v2 adapter (read side). Paths per the published OpenAPI spec; see docs/decisions/0001.
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { isoDurationToMs } from '../core/duration'
import { getAccessToken } from '../utils/accounts'
import { chunk, createClient } from './http'
import type { MusicProvider } from './types'

const BASE = 'https://openapi.tidal.com/v2'

/** Map JSON:API track resources plus their included artists and albums to ProviderTracks. */
export function toTidalTracks(data: any[], included: any[]): ProviderTrack[] {
  const byKey = new Map(included.map(r => [`${r.type}:${r.id}`, r]))
  return data.filter(r => r?.type === 'tracks').map((r): ProviderTrack => {
    const a = r.attributes ?? {}
    const artistIds: any[] = r.relationships?.artists?.data ?? []
    const albumId = r.relationships?.albums?.data?.[0]
    return {
      providerTrackId: String(r.id),
      isrc: a.isrc?.toUpperCase() ?? null,
      title: a.title ?? '',
      artists: artistIds.map(x => byKey.get(`artists:${x.id}`)?.attributes?.name).filter(Boolean),
      album: albumId ? byKey.get(`albums:${albumId.id}`)?.attributes?.title ?? '' : '',
      durationMs: isoDurationToMs(a.duration),
      explicit: Boolean(a.explicit),
      version: a.version || null,
    }
  })
}

/** Resolve a JSON:API `links.next`, which may be relative to the API root or the host. */
export function nextUrl(next: string | null | undefined): string | null {
  if (!next) return null
  if (next.startsWith('http')) return next
  if (next.startsWith('/v2/')) return `https://openapi.tidal.com${next}`
  return `${BASE}${next.startsWith('/') ? '' : '/'}${next}`
}

export function createTidal(country: string): MusicProvider {
  const request = createClient('tidal', BASE, () => getAccessToken('tidal'), 'application/vnd.api+json')

  async function pages(path: string, query: Record<string, string | string[]> = {}): Promise<{ data: any[], included: any[] }> {
    const data: any[] = []
    const included: any[] = []
    let page: any = await request(path, { query })
    for (;;) {
      data.push(...(Array.isArray(page.data) ? page.data : [page.data]))
      included.push(...(page.included ?? []))
      const next = nextUrl(page.links?.next)
      if (!next) return { data, included }
      page = await request(next)
    }
  }

  /** Full track objects with artists and album, 20 IDs per call. Preserves input order. */
  async function hydrate(ids: string[]): Promise<ProviderTrack[]> {
    const found = new Map<string, ProviderTrack>()
    for (const batch of chunk([...new Set(ids)], 20)) {
      const res: any = await request('/tracks', { query: { 'filter[id]': batch, include: ['artists', 'albums'], countryCode: country } })
      for (const t of toTidalTracks(res.data ?? [], res.included ?? [])) found.set(t.providerTrackId, t)
    }
    return ids.map(id => found.get(id)).filter((t): t is ProviderTrack => t !== undefined)
  }

  const trackIdsOf = (data: any[]) => data.filter(r => r?.type === 'tracks').map(r => String(r.id))

  return {
    id: 'tidal',

    async getLikedTracks() {
      const { data } = await pages('/userCollectionTracks/me/relationships/items')
      return hydrate(trackIdsOf(data))
    },

    async getOwnedPlaylists() {
      const { data } = await pages('/playlists', { 'filter[owners.id]': 'me', countryCode: country })
      return data.map((p): ProviderPlaylist => ({ providerCollectionId: String(p.id), name: p.attributes?.name ?? '' }))
    },

    async getPlaylistTracks(playlistId) {
      const { data } = await pages(`/playlists/${playlistId}/relationships/items`, { countryCode: country })
      return hydrate(trackIdsOf(data))
    },

    async findByIsrcs(isrcs) {
      const out = new Map<string, ProviderTrack[]>(isrcs.map(i => [i, []]))
      for (const batch of chunk(isrcs, 20)) {
        const res: any = await request('/tracks', { query: { 'filter[isrc]': batch, include: ['artists', 'albums'], countryCode: country } })
        for (const t of toTidalTracks(res.data ?? [], res.included ?? [])) {
          if (t.isrc && out.has(t.isrc)) out.get(t.isrc)!.push(t)
        }
      }
      return out
    },

    async search(query) {
      const res: any = await request(`/searchResults/${encodeURIComponent(query)}/relationships/tracks`, { query: { countryCode: country } })
      return hydrate(trackIdsOf(res.data ?? []).slice(0, 10))
    },
  }
}
