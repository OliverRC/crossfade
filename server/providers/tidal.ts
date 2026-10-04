// Tidal Open API v2 adapter: reads, plus the playlist cleanup editor at the end. Paths per the published OpenAPI spec; see docs/decisions/0001.
import { createHash } from 'node:crypto'
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { isoDurationToMs } from '../core/duration'
import { getAccessToken } from '../utils/accounts'
import { chunk, createClient, ProviderError } from './http'
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

type TidalRequest = ReturnType<typeof createClient>

/** Every page of a JSON:API collection, following `links.next`. */
async function readAll(request: TidalRequest, path: string, query: Record<string, string | string[]> = {}): Promise<{ data: any[], included: any[] }> {
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

export function createTidal(country: string): MusicProvider {
  const request = createClient('tidal', BASE, () => getAccessToken('tidal'), 'application/vnd.api+json')

  const pages = (path: string, query: Record<string, string | string[]> = {}) => readAll(request, path, query)

  /**
   * Tracks already fetched by this provider instance (one pull), null when Tidal does not offer it in the country.
   * A song in liked and in several playlists is fetched once, not once per collection.
   */
  const hydrated = new Map<string, ProviderTrack | null>()

  /** Full track objects with artists and album, 20 IDs per call. Preserves input order. */
  async function hydrate(ids: string[]): Promise<ProviderTrack[]> {
    for (const batch of chunk([...new Set(ids)].filter(id => !hydrated.has(id)), 20)) {
      const res: any = await request('/tracks', { query: { 'filter[id]': batch, include: ['artists', 'albums'], countryCode: country } })
      for (const id of batch) hydrated.set(id, null)
      for (const t of toTidalTracks(res.data ?? [], res.included ?? [])) hydrated.set(t.providerTrackId, t)
    }
    return ids.map(id => hydrated.get(id)).filter((t): t is ProviderTrack => Boolean(t))
  }

  const trackIdsOf = (data: any[]) => data.filter(r => r?.type === 'tracks').map(r => String(r.id))

  /**
   * Every track in a list, as stored. The list is read without a country code so songs Tidal no longer offers
   * still appear, marked unavailable, rather than vanishing and looking like a removal.
   */
  async function readTracks(path: string): Promise<ProviderTrack[]> {
    const { data, included } = await pages(path, { include: ['items'] })
    const ids = trackIdsOf(data)
    const stored = new Map(toTidalTracks(included, []).map(t => [t.providerTrackId, t]))
    const playable = new Map((await hydrate(ids)).map(t => [t.providerTrackId, t]))
    return ids.flatMap((id) => {
      const t = playable.get(id) ?? (stored.has(id) ? { ...stored.get(id)!, available: false } : undefined)
      return t ? [t] : []
    })
  }

  return {
    id: 'tidal',
    isrcBatchSize: 20,

    getLikedTracks: () => readTracks('/userCollectionTracks/me/relationships/items'),

    async getPlaylists() {
      const { data } = await pages('/playlists', { 'filter[owners.id]': 'me', countryCode: country })
      return data.map((p): ProviderPlaylist => ({ providerCollectionId: String(p.id), name: p.attributes?.name ?? '', access: 'owned' }))
    },

    getPlaylistTracks: playlistId => readTracks(`/playlists/${playlistId}/relationships/items`),

    async findByIsrcs(isrcs) {
      const out = new Map<string, ProviderTrack[]>(isrcs.map(i => [i, []]))
      const batches = chunk(isrcs, 20)
      for (const batch of batches) {
        const res: any = await request('/tracks', { query: { 'filter[isrc]': batch, include: ['artists', 'albums'], countryCode: country } })
        for (const t of toTidalTracks(res.data ?? [], res.included ?? [])) {
          if (t.isrc && out.has(t.isrc)) out.get(t.isrc)!.push(t)
        }
      }
      return { tracks: out, requests: batches.length }
    },

    async search(query) {
      const res: any = await request(`/searchResults/${encodeURIComponent(query)}/relationships/tracks`, { query: { countryCode: country } })
      return hydrate(trackIdsOf(res.data ?? []).slice(0, 10))
    },
  }
}

export interface PlaylistItemRef {
  type: 'tracks' | 'videos'
  id: string
  /** Null for videos and for tracks Tidal returned no ISRC for. */
  isrc: string | null
}

export interface TidalPlaylistInfo {
  id: string
  name: string
  description: string | null
  accessType: string | null
  numberOfItems: number
}

/**
 * Playlist cleanup on Tidal (docs/decisions/0004): the only write path before M5.
 * Items are read as stored, without a country code, so nothing region-unavailable is hidden from the merge.
 */
export interface TidalPlaylistEditor {
  /** Null when the playlist no longer exists. */
  getPlaylist(id: string): Promise<TidalPlaylistInfo | null>
  getItems(id: string): Promise<PlaylistItemRef[]>
  /** The items Tidal still offers in the account's country, as `type:id`. The rest were pulled. */
  playable(items: PlaylistItemRef[]): Promise<Set<string>>
  /** A playable track for each ISRC that has one: a pulled song can return under a new ID. */
  findPlayableByIsrcs(isrcs: string[]): Promise<Map<string, PlaylistItemRef>>
  /** Appends items, skipping any already present. */
  addItems(id: string, items: PlaylistItemRef[]): Promise<void>
  deletePlaylist(id: string): Promise<void>
}

export function createTidalPlaylistEditor(country: string): TidalPlaylistEditor {
  const request = createClient('tidal', BASE, () => getAccessToken('tidal'), 'application/vnd.api+json')

  return {
    async getPlaylist(id) {
      try {
        const res: any = await request(`/playlists/${id}`)
        const a = res.data?.attributes ?? {}
        return { id, name: a.name ?? '', description: a.description ?? null, accessType: a.accessType ?? null, numberOfItems: Number(a.numberOfItems ?? 0) }
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null
        throw error
      }
    },

    async getItems(id) {
      const { data, included } = await readAll(request, `/playlists/${id}/relationships/items`, { include: ['items'] })
      const isrcOf = new Map(included.filter(r => r?.type === 'tracks').map(r => [String(r.id), r.attributes?.isrc?.toUpperCase() ?? null]))
      return data.filter(r => r?.type === 'tracks' || r?.type === 'videos')
        .map((r): PlaylistItemRef => ({ type: r.type, id: String(r.id), isrc: r.type === 'tracks' ? isrcOf.get(String(r.id)) ?? null : null }))
    },

    async playable(items) {
      const out = new Set<string>()
      for (const type of ['tracks', 'videos'] as const) {
        for (const batch of chunk([...new Set(items.filter(i => i.type === type).map(i => i.id))], 20)) {
          const res: any = await request(`/${type}`, { query: { 'filter[id]': batch, countryCode: country } })
          for (const r of res.data ?? []) out.add(`${type}:${r.id}`)
        }
      }
      return out
    },

    async findPlayableByIsrcs(isrcs) {
      const out = new Map<string, PlaylistItemRef>()
      for (const batch of chunk([...new Set(isrcs)], 20)) {
        const res: any = await request('/tracks', { query: { 'filter[isrc]': batch, countryCode: country } })
        for (const r of res.data ?? []) {
          const isrc = r.attributes?.isrc?.toUpperCase()
          if (isrc && !out.has(isrc)) out.set(isrc, { type: 'tracks', id: String(r.id), isrc })
        }
      }
      return out
    },

    async addItems(id, items) {
      for (const batch of chunk(items, 50)) {
        const body = { data: batch.map(i => ({ type: i.type, id: i.id })), meta: { onDuplicates: 'SKIP' } }
        await request(`/playlists/${id}/relationships/items`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey('add', id, batch) } })
      }
    },

    async deletePlaylist(id) {
      await request(`/playlists/${id}`, { method: 'DELETE', headers: { 'Idempotency-Key': idempotencyKey('delete', id, []) } })
    },
  }
}

/** Same request, same key: a retried write is replayed by Tidal rather than applied twice. */
function idempotencyKey(action: string, playlistId: string, items: PlaylistItemRef[]): string {
  return createHash('sha256').update(JSON.stringify([action, playlistId, items.map(i => `${i.type}:${i.id}`)])).digest('hex').slice(0, 64)
}
