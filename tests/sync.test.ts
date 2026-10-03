// End-to-end dry run against fake providers and a throwaway SQLite file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CollectionDiff, ProviderTrack } from '../shared/types'
import { QuotaError } from '../server/providers/http'
import type { MusicProvider } from '../server/providers/types'

const t = (id: string, title: string, artist: string, isrc: string | null, over: Partial<ProviderTrack> = {}): ProviderTrack =>
  ({ providerTrackId: id, isrc, title, artists: [artist], album: 'Album', durationMs: 240_000, explicit: false, version: null, ...over })

// Spotify: A, B, C (no ISRC), D (nowhere on Tidal). Tidal: A, E.
const S = { A: t('sA', 'Glass Horizon', 'Halcyon Drift', 'ZAQX1'), B: t('sB', 'Signal Bloom', 'Mira Solace', 'ZAQX2'), C: t('sC', 'Lanterns', 'Kei Tanabe', null), D: t('sD', 'Lattice', 'Static Cathedral', 'ZAQX4'), E: t('sE', 'Afterimage', 'Mira Solace', 'ZAQX5') }
const T = { A: t('tA', 'Glass Horizon', 'Halcyon Drift', 'ZAQX1'), B: t('tB', 'Signal Bloom', 'Mira Solace', 'ZAQX2'), C: t('tC', 'Lanterns', 'Kei Tanabe', 'ZAQX3', { version: '2024 Remaster', durationMs: 241_000 }), E: t('tE', 'Afterimage', 'Mira Solace', 'ZAQX5') }

const calls: string[] = []
/** Set to make a provider answer every call with QUOTA_EXCEEDED. */
const exhausted = new Set<string>()
const guard = (id: string, what: string) => {
  if (exhausted.has(id)) throw new QuotaError(id as 'spotify', `${id} ${what} → 429 QUOTA_EXCEEDED`, null)
  calls.push(`${id}:${what}`)
}

// ISRC lookups take one ISRC per call here, so tests can stop a lookup part-way.
function fake(id: 'spotify' | 'tidal', liked: ProviderTrack[], playlists: Record<string, { name: string, tracks: ProviderTrack[] }>, catalogue: ProviderTrack[]): MusicProvider {
  return {
    id,
    isrcBatchSize: id === 'spotify' ? 1 : 20,
    getLikedTracks: async () => { guard(id, 'liked'); return liked },
    getOwnedPlaylists: async () => { guard(id, 'playlists'); return Object.entries(playlists).map(([providerCollectionId, p]) => ({ providerCollectionId, name: p.name })) },
    getPlaylistTracks: async (pid) => { guard(id, `playlist:${pid}`); return playlists[pid]!.tracks },
    findByIsrcs: async (isrcs) => {
      guard(id, `isrc:${isrcs.join(',')}`)
      return { tracks: new Map(isrcs.map(i => [i, catalogue.filter(c => c.isrc === i)])), requests: 1 }
    },
    search: async (q) => {
      guard(id, `search:${q}`)
      return catalogue.filter(c => q.toLowerCase().includes(c.title.toLowerCase()))
    },
  }
}

const providers = {
  spotify: fake('spotify', [S.A, S.B, S.C, S.D], { s1: { name: 'Night Drive', tracks: [S.A, S.B] }, s2: { name: 'Gym Rotation', tracks: [S.D] } }, Object.values(S)),
  tidal: fake('tidal', [T.A, T.E], { t1: { name: 'night drive', tracks: [T.A] } }, Object.values(T)),
}

let runSync: typeof import('../server/jobs/sync').runSync
let newRun: () => number
const unlimited = { lookupBudget: { spotify: Infinity, tidal: Infinity }, fuzzySearch: false }
const withFuzzy = { ...unlimited, fuzzySearch: true }

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'crossfade-')), 'test.db')
  const { useDb } = await import('../server/utils/db')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  migrate(useDb(), { migrationsFolder: resolve('server/db/migrations') })
  runSync = (await import('../server/jobs/sync')).runSync
  const { schema } = await import('../server/utils/db')
  newRun = () => useDb().insert(schema.syncRuns).values({ kind: 'sync', trigger: 'manual', startedAt: new Date().toISOString(), status: 'running' }).returning().get().id
})

const byTitle = (c: CollectionDiff | undefined) =>
  Object.fromEntries((c?.rows ?? []).map(r => [(r.spotify ?? r.tidal)!.title, { state: r.state, target: r.target, method: r.method, reason: r.reason, candidate: r.candidate?.title }]))

describe('dry-run sync', () => {
  let first: CollectionDiff[]

  it('plans the union merge for liked songs', async () => {
    const outcome = await runSync(newRun(), () => {}, providers, withFuzzy)
    expect(outcome.pause).toBeNull()
    first = outcome.collections
    expect(byTitle(first.find(c => c.kind === 'liked'))).toEqual({
      'Glass Horizon': { state: 'in_sync' },
      'Signal Bloom': { state: 'add', target: 'tidal', method: 'isrc' },
      'Lanterns': { state: 'review', target: 'tidal', method: 'fuzzy', candidate: 'Lanterns (2024 Remaster)' },
      'Lattice': { state: 'unmatched', target: 'tidal', reason: 'not_found' },
      'Afterimage': { state: 'add', target: 'spotify', method: 'isrc' },
    })
  })

  it('pairs playlists by normalised name and reuses track links', () => {
    const night = first.find(c => c.name === 'Night Drive')
    expect(night).toMatchObject({ onSpotify: true, onTidal: true })
    expect(byTitle(night)).toEqual({ 'Glass Horizon': { state: 'in_sync' }, 'Signal Bloom': { state: 'add', target: 'tidal', method: 'isrc' } })
  })

  it('flags a playlist that exists on one side only', () => {
    expect(first.find(c => c.name === 'Gym Rotation')).toMatchObject({ onSpotify: true, onTidal: false })
  })

  it('remembers matching results: a second run makes no lookups and plans the same', async () => {
    calls.length = 0
    const second = await runSync(newRun(), () => {}, providers, withFuzzy)
    expect(calls.filter(c => c.includes('isrc') || c.includes('search'))).toEqual([])
    expect(second.collections.map(byTitle)).toEqual(first.map(byTitle))
  })
})

describe('fuzzy search off (the V0 default)', () => {
  it('records an ISRC miss as no_isrc_match without spending a search', async () => {
    const lonely = t('sX', 'Only Here', 'Nobody', 'ZZNONE1')
    calls.length = 0
    const out = await runSync(newRun(), () => {}, { spotify: fake('spotify', [lonely], {}, []), tidal: fake('tidal', [], {}, []) }, unlimited)
    expect(byTitle(out.collections.find(c => c.kind === 'liked'))['Only Here']).toMatchObject({ state: 'unmatched', reason: 'no_isrc_match' })
    expect(calls.filter(c => c.includes('search'))).toEqual([])
  })
})

describe('checkpoints and pauses', () => {
  // A fresh library per test: new track IDs and ISRCs, so nothing is already matched.
  let n = 0
  const library = () => {
    n++
    const s = [1, 2, 3].map(i => t(`s${n}-${i}`, `Song ${n}-${i}`, 'Artist', `ISRC${n}${i}`))
    const tOnly = [4, 5, 6].map(i => t(`t${n}-${i}`, `Song ${n}-${i}`, 'Artist', `ISRC${n}${i}`))
    const sCatalogue = tOnly.map(x => ({ ...x, providerTrackId: `s-cat-${x.providerTrackId}` }))
    const tCatalogue = s.map(x => ({ ...x, providerTrackId: `t-cat-${x.providerTrackId}` }))
    return {
      spotify: fake('spotify', s, { [`sp${n}a`]: { name: `List ${n}a`, tracks: [s[0]!] }, [`sp${n}b`]: { name: `List ${n}b`, tracks: [s[1]!] } }, sCatalogue),
      tidal: fake('tidal', tOnly, {}, tCatalogue),
    }
  }
  const liked = (c: CollectionDiff[]) => c.find(x => x.kind === 'liked')!.counts

  it('a quota hit while fetching pauses the run and keeps what was fetched; resuming skips it', async () => {
    const lib = library()
    const runId = newRun()
    calls.length = 0
    const spotify = lib.spotify
    let fetchedPlaylists = 0
    // Spotify runs out after its first playlist.
    lib.spotify = { ...spotify, getPlaylistTracks: async (pid) => { if (fetchedPlaylists++ >= 1) throw new QuotaError('spotify', 'quota', 3600); return spotify.getPlaylistTracks(pid) } }

    const paused = await runSync(runId, () => {}, lib, unlimited)
    expect(paused.pause).toMatchObject({ provider: 'spotify', reason: 'quota' })
    expect(paused.collections).toEqual([])
    expect(Date.parse(paused.pause!.resumeAt) - Date.now()).toBeGreaterThan(3500_000) // honours Retry-After
    expect(calls).toContain('tidal:liked') // Tidal kept going while Spotify was paused

    calls.length = 0
    lib.spotify = spotify
    const resumed = await runSync(runId, () => {}, lib, unlimited)
    expect(resumed.pause).toBeNull()
    // Only the playlist that failed is fetched again; liked songs, the first playlist and all of Tidal come from checkpoints.
    expect(calls.filter(c => !c.includes('isrc') && !c.includes('search'))).toEqual([`spotify:playlist:sp${n}b`])
    expect(liked(resumed.collections)).toMatchObject({ add: 6, pending: 0 })
  })

  it('a quota hit while matching keeps every match made so far and shows the rest as pending', async () => {
    const lib = library()
    const runId = newRun()
    const spotify = lib.spotify
    let lookups = 0
    // Spotify answers one ISRC lookup, then runs out.
    lib.spotify = { ...spotify, findByIsrcs: async (i) => { if (lookups++ >= 1) throw new QuotaError('spotify', 'quota', null); return spotify.findByIsrcs(i) } }

    const paused = await runSync(runId, () => {}, lib, unlimited)
    expect(paused.pause).toMatchObject({ provider: 'spotify', reason: 'quota' })
    // Tidal-bound lookups all finished; Spotify-bound ones stopped part-way.
    expect(liked(paused.collections)).toMatchObject({ add: 3 + 1, pending: 2 })

    lib.spotify = spotify
    calls.length = 0
    const resumed = await runSync(runId, () => {}, lib, unlimited)
    expect(liked(resumed.collections)).toMatchObject({ add: 6, pending: 0 })
    expect(calls.filter(c => c.startsWith('spotify:isrc'))).toHaveLength(2) // only the two still pending
  })

  it('a spent lookup budget pauses instead of draining the quota', async () => {
    const lib = library()
    const paused = await runSync(newRun(), () => {}, lib, { lookupBudget: { spotify: 2, tidal: Infinity }, fuzzySearch: false })
    expect(paused.pause).toMatchObject({ provider: 'spotify', reason: 'budget' })
    expect(liked(paused.collections)).toMatchObject({ add: 3 + 2, pending: 1 })
  })
})

describe('run log', () => {
  it('records each stage and the notable events of a run', async () => {
    const { useDb, schema } = await import('../server/utils/db')
    const { eq } = await import('drizzle-orm')
    const { createRunLog } = await import('../server/jobs/run-log')
    const id = newRun()
    const lonely = t('sLog', 'Logged', 'Someone', 'ZZLOG1')
    await runSync(id, () => {}, { spotify: fake('spotify', [lonely], { pl: { name: 'Mix', tracks: [lonely] } }, []), tidal: fake('tidal', [], {}, []) }, unlimited, createRunLog(id))

    const run = useDb().select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)).get()!
    expect(Object.fromEntries(Object.entries(run.stages!).map(([k, s]) => [k, s.status]))).toEqual({
      'fetch:spotify': 'done', 'fetch:tidal': 'done', 'link': 'done', 'pair': 'done', 'match:tidal': 'done', 'match:spotify': 'skipped', 'diff': 'done',
    })
    expect(run.stages!['fetch:spotify']).toMatchObject({ done: 2, total: 2, detail: '2 tracks in 2 collections' })
    expect(run.stages!['match:tidal']!.detail).toContain('1 no match')

    const events = useDb().select().from(schema.syncEvents).where(eq(schema.syncEvents.runId, id)).all().map(e => e.message)
    expect(events).toContain('Found 1 playlist you own on Spotify')
    expect(events).toContain('Fetched "Mix": 1 track')
  })

  it('logs a quota pause as an issue on the stage it hit', async () => {
    const { useDb, schema } = await import('../server/utils/db')
    const { eq } = await import('drizzle-orm')
    const { createRunLog } = await import('../server/jobs/run-log')
    const id = newRun()
    const lib = { spotify: fake('spotify', [], {}, []), tidal: fake('tidal', [], {}, []) }
    lib.tidal = { ...lib.tidal, getLikedTracks: async () => { throw new QuotaError('tidal', 'tidal GET /x → 429 rate limited (Retry-After: 120)', 120) } }
    await runSync(id, () => {}, lib, unlimited, createRunLog(id))

    const run = useDb().select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)).get()!
    expect(run.stages!['fetch:tidal']!.status).toBe('paused')
    const warnings = useDb().select().from(schema.syncEvents).where(eq(schema.syncEvents.runId, id)).all().filter(e => e.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ stage: 'fetch:tidal' })
    expect(warnings[0]!.message).toContain('Everything fetched so far is saved')
  })
})
