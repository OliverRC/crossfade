// Tidal Open API v2 adapter: reads, plus the playlist cleanup editor at the end. Paths per the published OpenAPI spec; see docs/decisions/0001.
import { createHash } from 'node:crypto'
import type { ProviderPlaylist, ProviderTrack } from '../../shared/types'
import { isoDurationToMs } from '../core/duration'
import { getAccessToken } from '../utils/accounts'
import { chunk, createClient, ProviderError } from './http'
import type { MusicProvider, PlaylistEntry, PushWriter, WriteFailures } from './types'

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

/**
 * Push to Tidal (docs/decisions/0007). Requests per the published spec: playlist adds take `onDuplicates: SKIP` and
 * report songs they could not add in `meta.skipped`; playlist removals name each entry by `meta.itemId`; liked songs
 * are added and removed by track ID. All in batches of 50, each with an idempotency key so a retried request is
 * replayed rather than applied twice.
 */
export function createTidalWriter(country: string): PushWriter {
  const request = createClient('tidal', BASE, () => getAccessToken('tidal'), 'application/vnd.api+json')
  const key = (action: string, target: string, ids: string[]) =>
    createHash('sha256').update(JSON.stringify([action, target, ids])).digest('hex').slice(0, 64)

  /**
   * Liked songs have no "skip what is there": a batch with one song already liked (or already gone) may be refused
   * as a conflict. Then each song is sent alone, and a conflict or not-found for one song means it is already done.
   */
  async function likedWrite(method: 'POST' | 'DELETE', trackIds: string[]): Promise<WriteFailures> {
    const failures: WriteFailures = new Map()
    const send = (ids: string[]) => request('/userCollectionTracks/me/relationships/items', {
      method,
      body: { data: ids.map(id => ({ type: 'tracks', id })) },
      headers: { 'Idempotency-Key': key(`liked:${method}`, 'me', ids) },
    })
    // A conflict means already liked (adding) or already gone (removing); so does a not-found when removing. When
    // adding, not-found means Tidal has no such track: a real failure. Server errors and rate limits stop the push.
    const alreadyDone = (e: ProviderError) => e.status === 409 || (method === 'DELETE' && e.status === 404)
    const fatal = (e: unknown) => !(e instanceof ProviderError) || e.status === 429 || e.status >= 500
    for (const batch of chunk(trackIds, 50)) {
      try {
        await send(batch)
        continue
      } catch (error) {
        if (fatal(error)) throw error
        const e = error as ProviderError
        // One song can sink a batch: retry them one by one to find it.
        const split = batch.length > 1 && (e.status === 409 || e.status === 404)
        if (!split) {
          if (!alreadyDone(e)) for (const id of batch) failures.set(id, e.message)
          continue
        }
      }
      for (const id of batch) {
        try {
          await send([id])
        } catch (error) {
          if (fatal(error)) throw error
          if (!alreadyDone(error as ProviderError)) failures.set(id, (error as ProviderError).message)
        }
      }
    }
    return failures
  }

  return {
    id: 'tidal',

    async findPlayableByIsrcs(isrcs) {
      const out = new Map<string, string>()
      for (const batch of chunk([...new Set(isrcs)], 20)) {
        const res: any = await request('/tracks', { query: { 'filter[isrc]': batch, countryCode: country } })
        for (const r of res.data ?? []) {
          const isrc = r.attributes?.isrc?.toUpperCase()
          if (isrc && !out.has(isrc)) out.set(isrc, String(r.id))
        }
      }
      return out
    },

    async readPlaylist(playlistId) {
      try {
        const { data, included } = await readAll(request, `/playlists/${playlistId}/relationships/items`, { include: ['items'] })
        const isrcOf = new Map(included.filter(r => r?.type === 'tracks').map(r => [String(r.id), r.attributes?.isrc?.toUpperCase() ?? null]))
        return data.filter(r => r?.type === 'tracks')
          .map((r): PlaylistEntry => ({ trackId: String(r.id), entryId: r.meta?.itemId ?? null, isrc: isrcOf.get(String(r.id)) ?? null }))
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null
        throw error
      }
    },

    async addToPlaylist(playlistId, trackIds) {
      const failures: WriteFailures = new Map()
      for (const batch of chunk(trackIds, 50)) {
        const res: any = await request(`/playlists/${playlistId}/relationships/items`, {
          method: 'POST',
          body: { data: batch.map(id => ({ type: 'tracks', id })), meta: { onDuplicates: 'SKIP' } },
          headers: { 'Idempotency-Key': key('playlist:add', playlistId, batch) },
        })
        // ALREADY_PRESENT is success; NOT_FOUND means Tidal would not add it.
        for (const s of res?.meta?.skipped ?? []) {
          if (s?.reason === 'NOT_FOUND') failures.set(String(s.id), 'Tidal would not add it: not available')
        }
      }
      return failures
    },

    async removeFromPlaylist(playlistId, entries) {
      const failures: WriteFailures = new Map()
      const removable = entries.filter(e => e.entryId)
      for (const e of entries.filter(e => !e.entryId)) failures.set(e.trackId, 'Tidal did not say which entry this is, so it cannot be removed')
      for (const batch of chunk(removable, 50)) {
        await request(`/playlists/${playlistId}/relationships/items`, {
          method: 'DELETE',
          body: { data: batch.map(e => ({ type: 'tracks', id: e.trackId, meta: { itemId: e.entryId } })) },
          headers: { 'Idempotency-Key': key('playlist:remove', playlistId, batch.map(e => e.entryId!)) },
        })
      }
      return failures
    },

    addLiked: ids => likedWrite('POST', ids),
    removeLiked: ids => likedWrite('DELETE', ids),
  }
}
