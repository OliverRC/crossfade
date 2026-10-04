// Pull end to end against fake services and a throwaway SQLite file: main, snapshots, conflicts and held collections.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryView, PlaylistAccess, ProviderId, ProviderTrack } from '../shared/types'
import { ProviderError, QuotaError } from '../server/providers/http'
import type { MusicProvider, PlaylistEntry, PushWriter } from '../server/providers/types'
import type { RunLog } from '../server/jobs/run-log'

type Db = typeof import('../server/utils/db')
let db: ReturnType<Db['useDb']>
let schema: Db['schema']
let runPull: typeof import('../server/jobs/pull').runPull
let libraryView: typeof import('../server/utils/library').libraryView
let decisions: typeof import('../server/jobs/decisions')
let cleanup: typeof import('../server/jobs/cleanup')
let staging: typeof import('../server/utils/staging')
let runPush: typeof import('../server/jobs/push').runPush

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
  staging = await import('../server/utils/staging')
  runPush = (await import('../server/jobs/push')).runPush
})

describe('pull into main', () => {
  beforeEach(() => {
    for (const table of [schema.stagedChanges, schema.unavailableItems, schema.playlistBackups, schema.conflicts, schema.pullHolds, schema.snapshots, schema.memberships, schema.collectionLinks, schema.collections, schema.trackLinks, schema.canonicalTracks, schema.fetchCheckpoints, schema.syncEvents, schema.syncRuns]) db.delete(table).run()
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

  describe('metadata matching (decision 0008)', () => {
    const always = (id: string, isrc: string, album: string, over: Partial<ProviderTrack> = {}) => t(id, isrc, { title: 'Always', artists: ['Gavin James'], album, ...over })

    it('joins the same song with a different ISRC on each service, and the next pull finds nothing new', async () => {
      libraries.spotify = { liked: [], playlists: { sp: { name: 'Alt Tunes', tracks: [always('s-single', 'SINGLE', 'Always')] } } }
      libraries.tidal = { liked: [], playlists: { tp: { name: 'Alt Tunes', tracks: [always('t-album', 'ALBUM', 'Form & Function', { title: 'Always', durationMs: 201_000 })] } } }
      await pullOf('spotify')
      await pullOf('tidal')
      expect(rowsOf('Alt Tunes').map(r => r.state)).toEqual(['in_sync'])
      // Each side shows its own release, and the row says the ISRCs differ.
      expect(rowsOf('Alt Tunes')[0]).toMatchObject({ matchedBy: 'metadata', copies: { spotify: { isrc: 'SINGLE', album: 'Always' }, tidal: { isrc: 'ALBUM', album: 'Form & Function' } } })
      expect(db.select().from(schema.canonicalTracks).all()).toHaveLength(1)
      expect(db.select().from(schema.trackLinks).all().map(l => `${l.providerTrackId}:${l.method}`).sort()).toEqual(['s-single:origin', 't-album:metadata'])
      const again = await pullOf('tidal')
      expect(again.counts).toMatchObject({ added: 0, removed: 0, confirmed: 0, conflicts: 0, held: 0 })
      expect((await pullOf('spotify')).counts).toMatchObject({ added: 0, removed: 0, conflicts: 0 })
    })

    it('joins a single and an album release that are each already linked on both services', async () => {
      // Liked songs link each release on both services by ISRC; the playlists hold a different release on each.
      libraries.spotify = { liked: [always('s-album', 'ALBUM', 'Form & Function')], playlists: { sp: { name: 'Alt Tunes', tracks: [always('s-single', 'SINGLE', 'Always')] } } }
      libraries.tidal = { liked: [always('t-single', 'SINGLE', 'Always')], playlists: { tp: { name: 'Alt Tunes', tracks: [always('t-album', 'ALBUM', 'Form & Function')] } } }
      await pullOf('tidal')
      await pullOf('spotify')
      expect(rowsOf('Alt Tunes').map(r => r.state)).toEqual(['in_sync'])
      expect(rowsOf('Liked songs').map(r => r.state)).toEqual(['in_sync'])
      expect(rowsOf('Liked songs')[0]!.matchedBy).toBe('metadata')
      expect(libraryView().totals.add).toEqual({ spotify: 0, tidal: 0 })
      expect((await pullOf('tidal')).counts).toMatchObject({ added: 0, removed: 0, confirmed: 0, conflicts: 0 })
    })

    it('does not join a live version, or two copies only one service holds', async () => {
      libraries.spotify = { liked: [always('s1', 'STUDIO', 'Always')], playlists: {} }
      libraries.tidal = { liked: [always('t1', 'LIVE', 'Always', { version: 'Live' }), always('t2', 'DEMO', 'Demos'), always('t3', 'RERECORD', 'Again')], playlists: {} }
      await pullOf('tidal')
      expect(db.select().from(schema.canonicalTracks).all()).toHaveLength(3)
      await pullOf('spotify')
      // Two Tidal copies could each be the Spotify song, so none of them joins; the live one never matches.
      expect(states('Liked songs')).toEqual({ STUDIO: 'present/missing', LIVE: 'missing/present', DEMO: 'missing/present', RERECORD: 'missing/present' })
    })
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
    // Pushing Gym to Spotify would still look for song 7 there.
    expect(collection(libraryView(), 'Gym').counts.addUnavailable).toEqual({ spotify: 1, tidal: 0 })
  })

  describe('staging (decision 0007)', () => {
    const key = (name: string) => Number(collection(libraryView(), name).key)
    const row = (name: string, isrc: string) => rowsOf(name).find(r => r.track.isrc === isrc)!
    const idOf = (name: string, isrc: string) => row(name, isrc).canonicalTrackId

    it('new changes start unstaged, and one song can be staged for one service', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      expect(libraryView().totals.staged).toEqual({ add: { spotify: 0, tidal: 0 }, remove: { spotify: 0, tidal: 0 } })
      expect(row('Liked songs', 'ISRC1')).toMatchObject({ change: { spotify: null, tidal: 'add' }, staged: { spotify: false, tidal: false } })

      expect(staging.setStaged({ collectionId: key('Liked songs'), canonicalTrackId: idOf('Liked songs', 'ISRC1'), provider: 'tidal' }, true)).toBe(1)
      expect(row('Liked songs', 'ISRC1').staged).toEqual({ spotify: false, tidal: true })
      expect(libraryView().totals.staged.add).toEqual({ spotify: 0, tidal: 1 })
      // Staging twice changes nothing.
      expect(staging.setStaged({ collectionId: key('Liked songs'), canonicalTrackId: idOf('Liked songs', 'ISRC1'), provider: 'tidal' }, true)).toBe(0)

      const view = staging.stagedView()
      expect(view.tidal).toMatchObject({ add: 1, remove: 0, collections: [{ name: 'Liked songs', createsPlaylist: false, add: [{ isrc: 'ISRC1' }], remove: [] }] })
      expect(view.spotify).toEqual({ collections: [], add: 0, remove: 0, needsLookup: 0, lookupBudget: 150 })
    })

    it('stages a collection or a service in bulk, and unstages it again', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      expect(staging.setStaged({ provider: 'spotify' }, true)).toBe(2)
      expect(libraryView().totals.staged.add).toEqual({ spotify: 2, tidal: 0 })
      // Gym is only on Tidal: pushing it to Spotify creates the playlist.
      expect(staging.stagedView().spotify.collections.find(c => c.name === 'Gym')).toMatchObject({ createsPlaylist: true })

      expect(staging.setStaged({ collectionId: key('Night Drive') }, true)).toBe(1)
      expect(libraryView().totals.staged.add).toEqual({ spotify: 2, tidal: 1 })
      expect(staging.setStaged({}, false)).toBe(3)
      expect(db.select().from(schema.stagedChanges).all()).toEqual([])
    })

    it('a song in conflict cannot be staged until the conflict is decided', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      libraries.tidal.playlists.tp1!.tracks = [T(1), T(2)]
      await pullOf('tidal')
      libraries.spotify.playlists.sp1!.tracks = [S(1)]
      await pullOf('spotify')
      const id = idOf('Night Drive', 'ISRC2')
      expect(staging.setStaged({ collectionId: key('Night Drive'), canonicalTrackId: id }, true)).toBe(0)
      decisions.resolveConflict(row('Night Drive', 'ISRC2').conflict!.id, 'keep')
      expect(staging.setStaged({ collectionId: key('Night Drive'), canonicalTrackId: id }, true)).toBe(1)
    })

    it('a staged change the service already matches is stale, and leaves the stage', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal' }, true)
      expect(libraryView().totals.staged.add.tidal).toBe(2)
      // Song 1 reaches Tidal's liked songs some other way.
      libraries.tidal.liked = [T(1), T(2), T(3), T(4)]
      await pullOf('tidal')
      expect(libraryView().totals.staged.add.tidal).toBe(1)
      expect(staging.pruneStaged()).toBe(1)
      expect(db.select().from(schema.stagedChanges).all()).toHaveLength(1)
    })

    it('a staged add does not count once main removes the song', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ collectionId: key('Liked songs'), provider: 'tidal' }, true)
      libraries.spotify.liked = [S(2), S(3)]
      await pullOf('spotify')
      // Removed from main and on neither service: settled, so not even a row.
      expect(rowsOf('Liked songs').some(r => r.track.isrc === 'ISRC1')).toBe(false)
      expect(libraryView().totals.staged.add.tidal).toBe(0)
      expect(staging.pruneStaged()).toBe(1)
    })
  })
  describe('push to Tidal (decision 0007, slice 2)', () => {
    const key = (name: string) => Number(collection(libraryView(), name).key)
    /** ISRCs Tidal will not find, and track IDs it refuses to add. */
    let missingOnTidal = new Set<string>()
    let refused = new Set<string>()
    let writes: string[] = []
    const quietLog: RunLog = { stage: () => {}, event: () => {}, current: () => null, flush: () => {} }

    /** Lookup requests made, and the ISRC batch on which the fake service answers QUOTA_EXCEEDED. */
    let lookups: string[][] = []
    let quotaOnLookup: number | null = null

    function fakeWriter(provider: ProviderId = 'tidal', opts: { budget?: number | null, batch?: number } = {}): PushWriter {
      const lib = libraries[provider]
      const prefix = provider === 'tidal' ? 't' : 's'
      const byId = (id: string) => (provider === 'tidal' ? T : S)(Number(id.slice(1)))
      return {
        id: provider,
        isrcBatchSize: opts.batch ?? 20,
        lookupBudget: opts.budget ?? null,
        findPlayableByIsrcs: async (isrcs) => {
          lookups.push(isrcs)
          if (quotaOnLookup === lookups.length) throw new QuotaError(provider, `${provider} GET /search → 429 QUOTA_EXCEEDED`, null)
          return { found: new Map(isrcs.filter(i => !missingOnTidal.has(i)).map(i => [i, `${prefix}${i.replace('ISRC', '')}`])), requests: 1 }
        },
        readPlaylist: async (pid) => {
          const p = lib.playlists[pid]
          return p ? p.tracks.map((t, n): PlaylistEntry => ({ trackId: t.providerTrackId, entryId: `${pid}-${n}`, isrc: t.isrc })) : null
        },
        addToPlaylist: async (pid, ids) => {
          writes.push(`add ${pid} ${ids.join(',')}`)
          const ok = ids.filter(id => !refused.has(id))
          lib.playlists[pid]!.tracks.push(...ok.map(byId))
          return new Map(ids.filter(id => refused.has(id)).map(id => [id, 'Tidal would not add it: not available']))
        },
        removeFromPlaylist: async (pid, entries) => {
          writes.push(`remove ${pid} ${entries.map(e => e.trackId).join(',')}`)
          const gone = new Set(entries.map(e => e.trackId))
          lib.playlists[pid]!.tracks = lib.playlists[pid]!.tracks.filter(t => !gone.has(t.providerTrackId))
          return new Map()
        },
        addLiked: async (ids) => {
          writes.push(`like ${ids.join(',')}`)
          lib.liked.push(...ids.filter(id => !lib.liked.some(t => t.providerTrackId === id)).map(byId))
          return new Map()
        },
        removeLiked: async (ids) => {
          writes.push(`unlike ${ids.join(',')}`)
          lib.liked = lib.liked.filter(t => !ids.includes(t.providerTrackId))
          return new Map()
        },
      }
    }
    const push = () => runPush('tidal', fakeWriter(), () => {}, quietLog)

    beforeEach(() => { missingOnTidal = new Set(); refused = new Set(); writes = []; lookups = []; quotaOnLookup = null })

    it('writes only what is staged, then status, the stage and the next pull all agree', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal' }, true)
      // Staged for Spotify too, but a Tidal push leaves it alone.
      staging.setStaged({ provider: 'spotify', collectionId: key('Liked songs') }, true)

      expect(await push()).toEqual({ added: 2, removed: 0, failed: 0, skipped: 0, deferred: 0 })
      expect(writes).toEqual(['like t1', 'add tp1 t2'])
      expect(libraries.tidal.liked.map(t => t.isrc)).toContain('ISRC1')
      expect(libraries.tidal.playlists.tp1!.tracks.map(t => t.isrc)).toEqual(['ISRC1', 'ISRC2'])

      expect(states('Liked songs')).toEqual({ ISRC4: 'missing/present' })
      expect(states('Night Drive')).toEqual({})
      expect(db.select().from(schema.stagedChanges).all().map(r => r.provider)).toEqual(['spotify'])
      const again = await pullOf('tidal')
      expect(again.counts).toMatchObject({ added: 0, removed: 0, conflicts: 0, held: 0 })
    })

    it('pushes a removal from main to the Tidal playlist', async () => {
      libraries.tidal.playlists.tp1!.tracks = [T(1), T(2)]
      await pullOf('spotify')
      await pullOf('tidal')
      libraries.spotify.playlists.sp1!.tracks = [S(1)]
      await pullOf('spotify')
      expect(states('Night Drive')).toEqual({ ISRC2: 'absent/extra' })
      staging.setStaged({ provider: 'tidal', collectionId: key('Night Drive') }, true)

      expect(await push()).toMatchObject({ removed: 1, failed: 0 })
      expect(writes).toEqual(['remove tp1 t2'])
      expect(states('Night Drive')).toEqual({})
      expect((await pullOf('tidal')).counts).toMatchObject({ added: 0, removed: 0 })
    })

    it('a song Tidal does not have stays staged with the reason, and goes once Tidal has it', async () => {
      // Song 2 is in Tidal's liked songs, so its Tidal ID is known; song 9 Tidal has never had.
      libraries.spotify.playlists.sp1!.tracks = [S(1), S(2), S(9)]
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal', collectionId: key('Night Drive') }, true)
      missingOnTidal = new Set(['ISRC9'])

      expect(await push()).toMatchObject({ added: 1, failed: 1 })
      expect(writes).toEqual(['add tp1 t2'])
      expect(db.select().from(schema.stagedChanges).all()).toMatchObject([{ lastError: 'Not found on Tidal by ISRC ISRC9', attempts: 1 }])
      expect(staging.stagedView().tidal.collections[0]!.add).toMatchObject([{ isrc: 'ISRC9', error: 'Not found on Tidal by ISRC ISRC9', attempts: 1 }])
      await push()
      expect(db.select().from(schema.stagedChanges).all()).toMatchObject([{ attempts: 2 }])

      missingOnTidal = new Set()
      expect(await push()).toMatchObject({ added: 1, failed: 0 })
      expect(db.select().from(schema.stagedChanges).all()).toEqual([])
      expect(states('Night Drive')).toEqual({})
    })

    it('a song Tidal refuses to add is a failure on that song only', async () => {
      libraries.spotify.playlists.sp1!.tracks = [S(1), S(2), S(3)]
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal', collectionId: key('Night Drive') }, true)
      refused = new Set(['t3'])
      expect(await push()).toMatchObject({ added: 1, failed: 1 })
      expect(states('Night Drive')).toEqual({ ISRC3: 'present/missing' })
      expect(db.select().from(schema.stagedChanges).all()).toMatchObject([{ lastError: 'Tidal would not add it: not available' }])
    })

    it('does not write a song already in the playlist under any ID', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal', collectionId: key('Night Drive') }, true)
      // Song 2 reached the Tidal playlist since the last pull, as a different release.
      libraries.tidal.playlists.tp1!.tracks.push(t('t2b', 'ISRC2'))
      expect(await push()).toMatchObject({ added: 1, failed: 0 })
      expect(writes).toEqual([])
    })

    it('leaves a playlist Tidal does not have yet staged, without an error', async () => {
      libraries.spotify.playlists.sp9 = { name: 'Road Trip', tracks: [S(8)] }
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal', collectionId: key('Road Trip') }, true)
      expect(await push()).toMatchObject({ added: 0, skipped: 1, failed: 0 })
      expect(writes).toEqual([])
      expect(db.select().from(schema.stagedChanges).all()).toMatchObject([{ lastError: null, attempts: 0 }])
    })

    it('fails a playlist deleted on Tidal since the last pull, and keeps it staged', async () => {
      await pullOf('spotify')
      await pullOf('tidal')
      staging.setStaged({ provider: 'tidal', collectionId: key('Night Drive') }, true)
      delete libraries.tidal.playlists.tp1
      expect(await push()).toMatchObject({ failed: 1 })
      expect(db.select().from(schema.stagedChanges).all()[0]!.lastError).toMatch(/no longer on Tidal/)
    })
    describe('to Spotify (slice 3)', () => {
      /** Spotify liked 1–3 and Night Drive 1, 2; Tidal adds songs 10–17 to its liked songs, none known to Spotify. */
      async function setUp() {
        libraries.tidal.liked = [T(2), T(3), T(4), ...range(10, 17).map(T)]
        await pullOf('spotify')
        await pullOf('tidal')
        staging.setStaged({ provider: 'spotify' }, true)
      }

      it('pushes adds to Spotify liked songs, looking songs up by ISRC', async () => {
        await setUp()
        const counts = await runPush('spotify', fakeWriter('spotify', { batch: 5 }), () => {}, quietLog)
        expect(counts).toMatchObject({ added: 9, failed: 0, deferred: 0 })
        // Song 4 and 10–17 are looked up 5 at a time; Gym is not on Spotify, so song 5 waits for playlist creation.
        expect(lookups.flat().sort()).toEqual(['ISRC10', 'ISRC11', 'ISRC12', 'ISRC13', 'ISRC14', 'ISRC15', 'ISRC16', 'ISRC17', 'ISRC4'].sort())
        expect(counts.skipped).toBe(1)
        expect(libraries.spotify.liked.map(t => t.providerTrackId)).toEqual(expect.arrayContaining(['s4', 's10', 's17']))
        expect((await pullOf('spotify')).counts).toMatchObject({ added: 0, removed: 0, conflicts: 0 })
      })

      it('stops looking up at the budget; the rest stay staged without an error, and the next push carries on', async () => {
        await setUp()
        const first = await runPush('spotify', fakeWriter('spotify', { batch: 5, budget: 1 }), () => {}, quietLog)
        expect(lookups).toHaveLength(1)
        expect(first).toMatchObject({ added: 5, failed: 0, deferred: 4 })
        const left = db.select().from(schema.stagedChanges).all().filter(r => r.provider === 'spotify' && r.change === 'add')
        expect(left.filter(r => r.lastError)).toEqual([])

        lookups = []
        const second = await runPush('spotify', fakeWriter('spotify', { batch: 5, budget: 1 }), () => {}, quietLog)
        expect(second).toMatchObject({ added: 4, deferred: 0 })
      })

      it('stops on QUOTA_EXCEEDED without writing, keeps what it found, and records the cooldown', async () => {
        await setUp()
        quotaOnLookup = 2
        await expect(runPush('spotify', fakeWriter('spotify', { batch: 5 }), () => {}, quietLog)).rejects.toBeInstanceOf(QuotaError)
        expect(writes).toEqual([])
        // The first batch's five songs are linked, so the next push will not look them up again.
        expect(db.select().from(schema.trackLinks).all().filter(l => l.provider === 'spotify' && l.method === 'isrc')).toHaveLength(5)
        expect(db.select().from(schema.providerAccounts).all().find(a => a.provider === 'spotify')!.quotaBlockedUntil).not.toBeNull()
        db.update(schema.providerAccounts).set({ quotaBlockedUntil: null }).run()
      })
    })
  })
})
