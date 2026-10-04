// Playlist cleanup against a fake Tidal and a throwaway SQLite file: the merge guarantee, skips and local bookkeeping.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CleanupJobView, ProviderTrack } from '../shared/types'
import type { PlaylistItemRef, TidalPlaylistEditor } from '../server/providers/tidal'

type Db = typeof import('../server/utils/db')
let db: ReturnType<Db['useDb']>
let schema: Db['schema']
let cleanup: typeof import('../server/jobs/cleanup')

const track = (n: number): ProviderTrack =>
  ({ providerTrackId: `id${n}`, isrc: `ISRC${n}`, title: `Track ${n}`, artists: ['Artist'], album: 'Album', durationMs: 200_000, explicit: false, version: null })
const ref = (n: number): PlaylistItemRef => ({ type: 'tracks', id: `id${n}`, isrc: `ISRC${n}` })
const nums = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

interface FakePlaylist { name: string, items: PlaylistItemRef[], reportedCount?: number }

/**
 * A fake Tidal holding playlists in memory, recording every write. `dropOnAdd` silently loses that item when added;
 * `pulled` are IDs Tidal no longer offers (never added); `returned` maps a pulled song's ISRC to its new ID.
 */
function fakeTidal(playlists: Record<string, FakePlaylist>, dropOnAdd: string[] = [], pulled: string[] = [], returned: Record<string, string> = {}) {
  const writes: string[] = []
  const editor: TidalPlaylistEditor = {
    getPlaylist: async id => playlists[id] ? { id, name: playlists[id].name, description: 'by tunemymusic', accessType: 'PUBLIC', numberOfItems: playlists[id].reportedCount ?? playlists[id].items.length } : null,
    getItems: async id => [...playlists[id]!.items],
    playable: async items => new Set(items.filter(i => !pulled.includes(i.id)).map(i => `${i.type}:${i.id}`)),
    findPlayableByIsrcs: async isrcs => new Map(isrcs.filter(i => returned[i]).map(i => [i, { type: 'tracks' as const, id: returned[i]!, isrc: i }])),
    addItems: async (id, items) => {
      writes.push(`add ${id} ${items.map(i => i.id).join(',')}`)
      const have = new Set(playlists[id]!.items.map(i => i.id))
      playlists[id]!.items.push(...items.filter(i => !have.has(i.id) && !dropOnAdd.includes(i.id) && !pulled.includes(i.id)))
    },
    deletePlaylist: async (id) => { writes.push(`delete ${id}`); delete playlists[id] },
  }
  return { editor, writes, playlists }
}

/** Seed a finished sync that fetched these Tidal playlists, paired with Spotify where `spotifyPair` says. */
function seed(fetched: Record<string, { name: string, tracks: number[] }>, spotifyPair: Record<string, string> = {}) {
  for (const table of [schema.unavailableItems, schema.playlistBackups, schema.collectionLinks, schema.collections, schema.fetchCheckpoints, schema.syncRuns]) db.delete(table).run()
  const now = new Date().toISOString()
  const run = db.insert(schema.syncRuns).values({
    kind: 'sync', trigger: 'manual', startedAt: now, status: 'paused', attempts: 1,
    playlists: { tidal: Object.entries(fetched).map(([id, p]) => ({ providerCollectionId: id, name: p.name })) },
  }).returning().get()
  for (const [id, p] of Object.entries(fetched)) {
    db.insert(schema.fetchCheckpoints).values({ runId: run.id, provider: 'tidal', kind: 'playlist', collectionKey: id, name: p.name, tracks: p.tracks.map(track), fetchedAt: now }).run()
    const collectionId = db.insert(schema.collections).values({ kind: 'playlist', name: p.name }).returning().get().id
    db.insert(schema.collectionLinks).values({ collectionId, provider: 'tidal', providerCollectionId: id }).run()
    if (spotifyPair[id]) db.insert(schema.collectionLinks).values({ collectionId, provider: 'spotify', providerCollectionId: spotifyPair[id] }).run()
  }
  return run.id
}

async function finished(job: CleanupJobView) {
  while (job.running) await new Promise(r => setTimeout(r, 2))
  return job
}

const groupKey = (...ids: string[]) => `tidal:${[...ids].sort().join('+')}`

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'crossfade-')), 'test.db')
  const dbModule = await import('../server/utils/db')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  db = dbModule.useDb()
  schema = dbModule.schema
  migrate(db, { migrationsFolder: resolve('server/db/migrations') })
  db.insert(schema.providerAccounts).values({
    provider: 'tidal', providerUserId: 'me', accessToken: 'x', expiresAt: '2999-01-01T00:00:00Z', scopes: 'playlists.read playlists.write', updatedAt: '2026-10-03T00:00:00Z',
  }).run()
  cleanup = await import('../server/jobs/cleanup')
})

describe('playlist cleanup', () => {
  beforeEach(() => {
    // Emo: the Spotify-paired copy (a) has 10 tracks; copy b has those plus track 11.
    seed({ a: { name: 'Emo', tracks: nums(1, 10) }, b: { name: 'Emo', tracks: nums(1, 11) }, e: { name: 'Evo X', tracks: [] } }, { a: 'spotifyEmo' })
  })

  it('lists exact copies as mergeable, keeping the larger copy by default, and empty playlists for removal', () => {
    const view = cleanup.cleanupView()
    expect(view.groups).toMatchObject([{ key: groupKey('a', 'b'), tier: 'exact', actionable: true, copies: [{ id: 'b', items: 11, unique: 1, afterIfKept: 11 }, { id: 'a', items: 10, unique: 0, afterIfKept: 11 }] }])
    expect(view.empty).toMatchObject([{ key: 'tidal:e', name: 'Evo X', actionable: true }])
  })

  it('merges into the kept copy, reads it back, saves the spare, then deletes it', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(1, 11).map(ref) } })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'a' }], empties: [] }, tidal.editor))

    expect(job.outcomes).toMatchObject([{ status: 'done', added: 1, deleted: 1 }])
    expect(tidal.writes).toEqual(['add a id11', 'delete b'])

    // It is an Activity entry, with a line per playlist.
    const activity = db.select().from(schema.syncRuns).all().find(r => r.kind === 'cleanup')!
    expect(activity).toMatchObject({ provider: 'tidal', status: 'succeeded', counts: { merged: 1, deleted: 1, added: 1, failed: 0 } })
    expect(db.select().from(schema.syncEvents).all().map(e => e.message)).toContainEqual(expect.stringContaining('Merged "Emo"'))
    expect(tidal.playlists.a!.items.map(i => i.id)).toEqual(nums(1, 11).map(n => `id${n}`))

    const [backup] = db.select().from(schema.playlistBackups).all()
    expect(backup).toMatchObject({ playlistId: 'b', name: 'Emo', reason: 'merged', keptPlaylistId: 'a', description: 'by tunemymusic' })
    expect(backup!.items).toHaveLength(11)
    expect(backup!.deletedAt).toBeTruthy()

    // The next sync sees the merged playlist without refetching, and the deleted copy is gone.
    const checkpoints = db.select().from(schema.fetchCheckpoints).all()
    expect(checkpoints.map(c => c.collectionKey).sort()).toEqual(['a', 'e'])
    expect(checkpoints.find(c => c.collectionKey === 'a')!.tracks).toHaveLength(11)
    expect(db.select().from(schema.syncRuns).get()!.playlists!.tidal!.map(p => p.providerCollectionId)).toEqual(['a', 'e'])
    expect(cleanup.cleanupView().groups).toEqual([])
  })

  it('moves the Spotify pairing to the kept copy when the paired copy is deleted', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(1, 11).map(ref) } })
    await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'b' }], empties: [] }, tidal.editor))

    expect(tidal.writes).toEqual(['delete a'])
    const links = db.select().from(schema.collectionLinks).all()
    const kept = links.find(l => l.providerCollectionId === 'b')!
    const spotify = links.find(l => l.provider === 'spotify')!
    expect(kept.collectionId).toBe(spotify.collectionId)
    expect(links.some(l => l.providerCollectionId === 'a')).toBe(false)
    // The kept copy's old, now unlinked collection is removed.
    expect(db.select().from(schema.collections).all()).toHaveLength(2)
  })

  it('deletes nothing when an item fails to reach the kept playlist', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(1, 11).map(ref) } }, ['id11'])
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'a' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'failed', deleted: 0 })
    expect(job.outcomes[0]!.detail).toContain('no copy was deleted')
    expect(tidal.writes).toEqual(['add a id11'])
    expect(tidal.playlists.b).toBeDefined()
    expect(db.select().from(schema.playlistBackups).all()).toEqual([])
  })

  it('merges every playable song and remembers a pulled one instead of blocking', async () => {
    // Copy b holds track 11, which Tidal has pulled: it cannot be added to a, so a holds everything else.
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(1, 11).map(ref) } }, [], ['id11'])
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'a' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'done', added: 0, deleted: 1, pulled: 1 })
    expect(tidal.writes).toEqual(['delete b'])
    expect(db.select().from(schema.unavailableItems).all()).toMatchObject([{ itemId: 'id11', isrc: 'ISRC11', playlistId: 'a', playlistName: 'Emo', foundInPlaylistId: 'b', restoredAt: null }])
    expect(cleanup.cleanupView().pulled).toMatchObject([{ isrc: 'ISRC11', playlistName: 'Emo' }])
  })

  it('adds a pulled song that is back on Tidal under a new ID', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(1, 11).map(ref) } }, [], ['id11'], { ISRC11: 'id11new' })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'a' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'done', added: 1, pulled: 0 })
    expect(tidal.writes).toEqual(['add a id11new', 'delete b'])
    expect(db.select().from(schema.unavailableItems).all()).toEqual([])
  })

  it('skips a group whose copies drifted apart on Tidal since the sync', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref) }, b: { name: 'Emo', items: nums(5, 30).map(ref) } })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'a' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'skipped' })
    expect(tidal.writes).toEqual([])
  })

  it('touches nothing when Tidal returns fewer items than it reports', async () => {
    const tidal = fakeTidal({ a: { name: 'Emo', items: nums(1, 10).map(ref), reportedCount: 12 }, b: { name: 'Emo', items: nums(1, 11).map(ref) } })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'b' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'failed' })
    expect(tidal.writes).toEqual([])
  })

  it('removes an empty playlist after saving it, and skips one that gained items', async () => {
    const empty = fakeTidal({ e: { name: 'Evo X', items: [] } })
    const job = await finished(cleanup.startCleanup({ merges: [], empties: ['tidal:e'] }, empty.editor))
    expect(job.outcomes[0]).toMatchObject({ status: 'done', deleted: 1 })
    expect(empty.writes).toEqual(['delete e'])
    expect(db.select().from(schema.playlistBackups).get()).toMatchObject({ playlistId: 'e', reason: 'empty' })

    seed({ e: { name: 'Evo X', tracks: [] } })
    const filled = fakeTidal({ e: { name: 'Evo X', items: [ref(1)] } })
    const again = await finished(cleanup.startCleanup({ merges: [], empties: ['tidal:e'] }, filled.editor))
    expect(again.outcomes[0]).toMatchObject({ status: 'skipped' })
    expect(filled.writes).toEqual([])
  })

  it('merges same-named playlists with different tracks when chosen: the kept one gets every song', async () => {
    seed({ a: { name: 'Lo-Fi', tracks: nums(1, 10) }, b: { name: 'Lo-Fi', tracks: nums(8, 20) } })
    expect(cleanup.cleanupView().groups).toMatchObject([{ tier: 'different', actionable: true }])
    const tidal = fakeTidal({ a: { name: 'Lo-Fi', items: nums(1, 10).map(ref) }, b: { name: 'Lo-Fi', items: nums(8, 20).map(ref) } })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'b' }], empties: [] }, tidal.editor))

    expect(job.outcomes[0]).toMatchObject({ status: 'done', added: 7, deleted: 1 })
    expect(tidal.playlists.b!.items.map(i => i.id).sort()).toEqual(nums(1, 20).map(n => `id${n}`).sort())
    expect(tidal.playlists.a).toBeUndefined()
  })

  it('merges one copy inside another when chosen', async () => {
    seed({ a: { name: 'Heavy', tracks: nums(1, 7) }, b: { name: 'Heavy', tracks: nums(1, 9) } })
    const tidal = fakeTidal({ a: { name: 'Heavy', items: nums(1, 7).map(ref) }, b: { name: 'Heavy', items: nums(1, 9).map(ref) } })
    const job = await finished(cleanup.startCleanup({ merges: [{ key: groupKey('a', 'b'), keeperId: 'b' }], empties: [] }, tidal.editor))
    expect(job.outcomes[0]).toMatchObject({ status: 'done', added: 0, deleted: 1 })
  })
})
