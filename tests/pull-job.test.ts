// Pull end to end against fake services and a throwaway SQLite file: main, snapshots, conflicts and held collections.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryView, PlaylistAccess, ProviderId, ProviderTrack } from '../shared/types'
import { ProviderError, QuotaError } from '../server/providers/http'
import type { MusicProvider } from '../server/providers/types'

type Db = typeof import('../server/utils/db')
let db: ReturnType<Db['useDb']>
let schema: Db['schema']
let runPull: typeof import('../server/jobs/pull').runPull
let libraryView: typeof import('../server/utils/library').libraryView
let decisions: typeof import('../server/jobs/decisions')
let cleanup: typeof import('../server/jobs/cleanup')

const t = (id: string, isrc: string | null, over: Partial<ProviderTrack> = {}): ProviderTrack =>
  ({ providerTrackId: id, isrc, title: `Song ${isrc ?? id}`, artists: ['Artist'], album: 'Album', durationMs: 200_000, explicit: false, version: null, ...over })
/** The same song on each service: Spotify ID s<n>, Tidal ID t<n>, ISRC ISRC<n>. */
const S = (n: number) => t(`s${n}`, `ISRC${n}`)
const T = (n: number) => t(`t${n}`, `ISRC${n}`)
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

interface FakePlaylist { name: string, tracks: ProviderTrack[], access?: PlaylistAccess, /** Collaborative, but the service answers 403. */ refuses?: boolean }
interface Library { liked: ProviderTrack[], playlists: Record<string, FakePlaylist> }
const libraries: Record<ProviderId, Library> = { spotify: { liked: [], playlists: {} }, tidal: { liked: [], playlists: {} } }
let quotaOn: string | null = null

function fake(id: ProviderId): MusicProvider {
  const lib = () => libraries[id]
  const guard = (what: string) => { if (quotaOn === `${id}:${what}`) throw new QuotaError(id, `${id} ${what} → 429 QUOTA_EXCEEDED`, 3600) }
  return {
    id,
    isrcBatchSize: 20,
    getLikedTracks: async () => { guard('liked'); return lib().liked },
    getPlaylists: async () => Object.entries(lib().playlists).map(([providerCollectionId, p]) => ({ providerCollectionId, name: p.name, access: p.access ?? 'owned', ownerName: p.access ? 'Niki' : null })),
    getPlaylistTracks: async (pid) => {
      guard(pid)
      const p = lib().playlists[pid]!
      if (p.access === 'followed' || p.refuses) throw new ProviderError(id, 403, `${id} GET /playlists/${pid}/items → 403`)
      return p.tracks
    },
    findByIsrcs: async () => { throw new Error('a pull never looks songs up') },
    search: async () => { throw new Error('a pull never searches') },
  }
}

async function pullOf(provider: ProviderId) {
  const latest = db.select().from(schema.syncRuns).all().filter(r => r.provider === provider).at(-1)
  const run = latest && latest.status === 'paused'
    ? latest
    : db.insert(schema.syncRuns).values({ kind: 'pull', provider, trigger: 'manual', startedAt: new Date().toISOString(), status: 'running', attempts: 1, stages: {} }).returning().get()
  const outcome = await runPull(run.id, provider, () => {}, fake(provider))
  db.update(schema.syncRuns).set({ status: outcome.pause ? 'paused' : 'succeeded', finishedAt: outcome.pause ? null : new Date().toISOString() }).where(eq(schema.syncRuns.id, run.id)).run()
  return outcome
}

const collection = (view: LibraryView, name: string) => view.collections.find(c => c.name === name)!
const rowsOf = (name: string) => {
  const view = libraryView()
  return libraryView(collection(view, name).key).selected!.rows
}
/** Each song's state on Spotify and Tidal, leaving out songs in sync (the page hides them by default too). */
const states = (name: string) => Object.fromEntries(rowsOf(name).filter(r => r.state !== 'in_sync').map(r => [r.track.isrc, `${r.spotify}/${r.tidal}`]))

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'crossfade-')), 'test.db')
  const dbModule = await import('../server/utils/db')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  db = dbModule.useDb()
  schema = dbModule.schema
  migrate(db, { migrationsFolder: resolve('server/db/migrations') })
  for (const provider of ['spotify', 'tidal'] as const) {
    db.insert(schema.providerAccounts).values({ provider, providerUserId: 'me', accessToken: 'x', expiresAt: '2999-01-01T00:00:00Z', scopes: 'playlists.write', updatedAt: '2026-10-03T00:00:00Z' }).run()
  }
  runPull = (await import('../server/jobs/pull')).runPull
  libraryView = (await import('../server/utils/library')).libraryView
  decisions = await import('../server/jobs/decisions')
  cleanup = await import('../server/jobs/cleanup')
})

describe('pull into main', () => {
  beforeEach(() => {
    for (const table of [schema.unavailableItems, schema.playlistBackups, schema.conflicts, schema.pullHolds, schema.snapshots, schema.memberships, schema.collectionLinks, schema.collections, schema.trackLinks, schema.canonicalTracks, schema.fetchCheckpoints, schema.syncEvents, schema.syncRuns]) db.delete(table).run()
    quotaOn = null
    // Spotify: liked 1–3, Night Drive 1, 2. Tidal: liked 2–4, Night Drive 1, Gym only on Tidal.
    libraries.spotify = { liked: [S(1), S(2), S(3)], playlists: { sp1: { name: 'Night Drive', tracks: [S(1), S(2)] } } }
    libraries.tidal = { liked: [T(2), T(3), T(4)], playlists: { tp1: { name: 'night drive', tracks: [T(1)] }, tp2: { name: 'Gym', tracks: [T(5)] } } }
  })

  it('two first pulls fill main with the union, and status shows what each service is missing', async () => {
    await pullOf('spotify')
    expect(states('Liked songs')).toEqual({ ISRC1: 'present/unknown', ISRC2: 'present/unknown', ISRC3: 'present/unknown' })
    await pullOf('tidal')
    expect(states('Liked songs')).toEqual({ ISRC1: 'present/missing', ISRC4: 'missing/present' })
    expect(states('Night Drive')).toEqual({ ISRC2: 'present/missing' })
    expect(collection(libraryView(), 'Gym').on).toEqual({ spotify: false, tidal: true })
    expect(states('Gym')).toEqual({ ISRC5: 'missing/present' })
    expect(libraryView().totals.add).toEqual({ spotify: 2, tidal: 2 })
  })

  it('reads a collaborative playlist like your own and pairs it by name', async () => {
    libraries.spotify.playlists.sp2 = { name: 'Gym', tracks: [S(5), S(6)], access: 'collaborative' }
    await pullOf('tidal')
    await pullOf('spotify')
    const gym = collection(libraryView(), 'Gym')
    expect(gym.on).toEqual({ spotify: true, tidal: true })
    expect(gym.shared).toEqual({ spotify: { access: 'collaborative', ownerName: 'Niki' } })
    expect(states('Gym')).toEqual({ ISRC6: 'present/missing' })
  })

  it('lists a followed playlist without reading it: nothing to push, and no songs counted missing', async () => {
    libraries.spotify.playlists.sp2 = { name: 'Gym', tracks: [S(9)], access: 'followed' }
    libraries.spotify.playlists.sp3 = { name: 'Bali', tracks: [S(8)], access: 'followed' }
    await pullOf('tidal')
    const outcome = await pullOf('spotify')
    expect(outcome.counts.held).toBe(0)
    const gym = collection(libraryView(), 'Gym')
    expect(gym.on).toEqual({ spotify: false, tidal: true })
    expect(gym.shared).toEqual({ spotify: { access: 'followed', ownerName: 'Niki' } })
    expect(gym.counts.add.spotify).toBe(0)
    expect(rowsOf('Gym')).toMatchObject([{ state: 'in_sync', spotify: 'followed', tidal: 'present' }])
    // Followed only on Spotify, with no copy anywhere readable: listed, with no songs.
    expect(collection(libraryView(), 'Bali').shared.spotify?.access).toBe('followed')
    expect(rowsOf('Bali')).toEqual([])
    expect(db.select().from(schema.canonicalTracks).all().some(t => t.isrc === 'ISRC8' || t.isrc === 'ISRC9')).toBe(false)

    // Unfollowed: the empty listing goes; the Tidal copy stays, back to Tidal only.
    delete libraries.spotify.playlists.sp2
    delete libraries.spotify.playlists.sp3
    expect((await pullOf('spotify')).counts.held).toBe(0)
    expect(libraryView().collections.some(c => c.name === 'Bali')).toBe(false)
    expect(collection(libraryView(), 'Gym').shared).toEqual({})
  })

  it('treats a collaborative playlist the service refuses to read as followed', async () => {
    libraries.spotify.playlists.sp2 = { name: 'Gym', tracks: [S(5)], access: 'collaborative', refuses: true }
    await pullOf('tidal')
    const outcome = await pullOf('spotify')
    expect(outcome.pause).toBeNull()
    expect(collection(libraryView(), 'Gym').shared.spotify?.access).toBe('followed')
    expect(rowsOf('Gym')).toMatchObject([{ spotify: 'followed' }])
  })

  it('pulling again with nothing changed reports nothing new', async () => {
    await pullOf('spotify')
    await pullOf('tidal')
    const again = await pullOf('tidal')
    expect(again.counts).toMatchObject({ added: 0, removed: 0, confirmed: 0, conflicts: 0, held: 0 })
  })

  it('a song removed on Spotify leaves main, and Tidal shows it to remove', async () => {
    await pullOf('spotify')
    await pullOf('tidal')
    libraries.spotify.liked = [S(1), S(3)]
    const outcome = await pullOf('spotify')
    expect(outcome.counts.removed).toBe(1)
    expect(states('Liked songs')).toMatchObject({ ISRC2: 'absent/extra' })
  })

  it('a song Tidal no longer offers stays in main, marked unavailable', async () => {
    await pullOf('tidal')
    libraries.tidal.liked = [T(2), { ...T(3), available: false }, T(4)]
    const outcome = await pullOf('tidal')
    expect(outcome.counts.removed).toBe(0)
    expect(rowsOf('Liked songs').find(r => r.track.isrc === 'ISRC3')).toMatchObject({ state: 'unavailable', tidal: 'unavailable' })
  })

  it('holds a read that loses too many songs, and applies it once accepted', async () => {
    libraries.tidal.liked = range(1, 20).map(T)
    await pullOf('tidal')
    libraries.tidal.liked = range(1, 14).map(T)
    const outcome = await pullOf('tidal')
    expect(outcome.counts).toMatchObject({ removed: 0, held: 1 })
    const hold = collection(libraryView(), 'Liked songs').holds[0]!
    expect(hold).toMatchObject({ reason: 'mass_removal', before: 20, removing: 6 })

    decisions.resolveHold(hold.id, 'accept')
    expect(collection(libraryView(), 'Liked songs').holds).toEqual([])
    const removed = db.select().from(schema.memberships).all().filter(m => m.state === 'removed')
    expect(removed).toHaveLength(6)
  })

  it('flags a playlist gone from the service instead of removing its songs, and keeps it in main when asked', async () => {
    await pullOf('tidal')
    delete libraries.tidal.playlists.tp2
    const outcome = await pullOf('tidal')
    expect(outcome.counts).toMatchObject({ removed: 0, held: 1 })
    const hold = collection(libraryView(), 'Gym').holds[0]!
    expect(hold.reason).toBe('gone')

    decisions.resolveHold(hold.id, 'keep')
    const gym = collection(libraryView(), 'Gym')
    expect(gym.on.tidal).toBe(false)
    expect(states('Gym')).toEqual({ ISRC5: 'unknown/missing' })
  })

  it('a removal on Spotify after Tidal newly added the song is a conflict, settled by Oliver once', async () => {
    libraries.tidal.playlists.tp1!.tracks = [T(1)]
    await pullOf('spotify')
    await pullOf('tidal')
    // Tidal gets song 2 in Night Drive (as a push would), Spotify drops it.
    libraries.tidal.playlists.tp1!.tracks = [T(1), T(2)]
    await pullOf('tidal')
    libraries.spotify.playlists.sp1!.tracks = [S(1)]
    const outcome = await pullOf('spotify')
    expect(outcome.counts.conflicts).toBe(1)
    const row = rowsOf('Night Drive').find(r => r.track.isrc === 'ISRC2')!
    expect(row).toMatchObject({ state: 'conflict', conflict: { provider: 'spotify', change: 'removed' } })

    decisions.resolveConflict(row.conflict!.id, 'keep')
    expect(rowsOf('Night Drive').find(r => r.track.isrc === 'ISRC2')).toMatchObject({ state: 'add', spotify: 'missing', tidal: 'present' })
    expect((await pullOf('spotify')).counts.conflicts).toBe(0)
  })

  it('pauses on a quota error and resumes without fetching what it already has', async () => {
    quotaOn = 'spotify:sp1'
    const paused = await pullOf('spotify')
    expect(paused.pause).toMatchObject({ provider: 'spotify', reason: 'quota' })
    expect(db.select().from(schema.memberships).all()).toEqual([])

    quotaOn = 'spotify:liked' // would fail if liked songs were fetched again
    db.update(schema.providerAccounts).set({ quotaBlockedUntil: null }).run()
    const resumed = await pullOf('spotify')
    expect(resumed.pause).toBeNull()
    expect(states('Night Drive')).toEqual({ ISRC1: 'present/unknown', ISRC2: 'present/unknown' })
  })

  it('a cleanup after a pull leaves main knowing what the kept playlist holds, pulled songs included', async () => {
    // Two Tidal copies of Gym sharing songs 10–20: tp2 also has 6; tp3 also has 7, a song Tidal has pulled.
    const shared = range(10, 20)
    libraries.tidal.playlists.tp2 = { name: 'Gym', tracks: [...shared, 6].map(T) }
    libraries.tidal.playlists.tp3 = { name: 'Gym', tracks: [...shared.map(T), { ...T(7), available: false }] }
    await pullOf('spotify')
    await pullOf('tidal')

    const refs = (...ns: number[]) => ns.map(n => ({ type: 'tracks' as const, id: `t${n}`, isrc: `ISRC${n}` }))
    const tidal: Record<string, ReturnType<typeof refs>> = { tp2: refs(...shared, 6), tp3: refs(...shared, 7) }
    const editor = {
      getPlaylist: async (id: string) => (tidal[id] ? { id, name: 'Gym', description: null, accessType: 'PUBLIC', numberOfItems: tidal[id].length } : null),
      getItems: async (id: string) => [...tidal[id]!],
      playable: async (items: ReturnType<typeof refs>) => new Set(items.filter(i => i.id !== 't7').map(i => `${i.type}:${i.id}`)),
      findPlayableByIsrcs: async () => new Map(),
      addItems: async (id: string, items: ReturnType<typeof refs>) => { tidal[id]!.push(...items) },
      deletePlaylist: async (id: string) => { delete tidal[id] },
    }
    const group = cleanup.cleanupView().groups.find(g => g.name === 'Gym')!
    const job = cleanup.startCleanup({ merges: [{ key: group.key, keeperId: 'tp2' }], empties: [] }, editor)
    while (job.running) await new Promise(r => setTimeout(r, 2))
    expect(job.outcomes[0]).toMatchObject({ status: 'done', pulled: 1, deleted: 1 })

    // Main knows Tidal's kept Gym holds 5 and 6, and that 7 belongs there but is unavailable: nothing to push to Tidal.
    expect(states('Gym')).toMatchObject({ ISRC10: 'missing/present', ISRC6: 'missing/present', ISRC7: 'missing/unavailable' })
    expect(collection(libraryView(), 'Gym').counts.add.tidal).toBe(0)

    // The next Tidal pull does not read the pulled song as removed.
    libraries.tidal.playlists = { tp1: libraries.tidal.playlists.tp1!, tp2: { name: 'Gym', tracks: [...shared, 6].map(T) } }
    const again = await pullOf('tidal')
    expect(again.counts).toMatchObject({ removed: 0, held: 0 })
    expect(states('Gym')).toMatchObject({ ISRC7: 'missing/unavailable' })
  })
})
