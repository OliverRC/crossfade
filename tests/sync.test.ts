// End-to-end dry run against fake providers and a throwaway SQLite file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CollectionDiff, ProviderTrack } from '../shared/types'
import type { MusicProvider } from '../server/providers/types'

const t = (id: string, title: string, artist: string, isrc: string | null, over: Partial<ProviderTrack> = {}): ProviderTrack =>
  ({ providerTrackId: id, isrc, title, artists: [artist], album: 'Album', durationMs: 240_000, explicit: false, version: null, ...over })

// Spotify: A, B, C (no ISRC), D (nowhere on Tidal). Tidal: A, E.
const S = { A: t('sA', 'Glass Horizon', 'Halcyon Drift', 'ZAQX1'), B: t('sB', 'Signal Bloom', 'Mira Solace', 'ZAQX2'), C: t('sC', 'Lanterns', 'Kei Tanabe', null), D: t('sD', 'Lattice', 'Static Cathedral', 'ZAQX4'), E: t('sE', 'Afterimage', 'Mira Solace', 'ZAQX5') }
const T = { A: t('tA', 'Glass Horizon', 'Halcyon Drift', 'ZAQX1'), B: t('tB', 'Signal Bloom', 'Mira Solace', 'ZAQX2'), C: t('tC', 'Lanterns', 'Kei Tanabe', 'ZAQX3', { version: '2024 Remaster', durationMs: 241_000 }), E: t('tE', 'Afterimage', 'Mira Solace', 'ZAQX5') }

const calls: string[] = []
function fake(id: 'spotify' | 'tidal', liked: ProviderTrack[], playlists: Record<string, { name: string, tracks: ProviderTrack[] }>, catalogue: ProviderTrack[]): MusicProvider {
  return {
    id,
    getLikedTracks: async () => liked,
    getOwnedPlaylists: async () => Object.entries(playlists).map(([providerCollectionId, p]) => ({ providerCollectionId, name: p.name })),
    getPlaylistTracks: async pid => playlists[pid]!.tracks,
    findByIsrcs: async (isrcs) => {
      calls.push(`${id}:isrc:${isrcs.join(',')}`)
      return new Map(isrcs.map(i => [i, catalogue.filter(c => c.isrc === i)]))
    },
    search: async (q) => {
      calls.push(`${id}:search:${q}`)
      return catalogue.filter(c => q.toLowerCase().includes(c.title.toLowerCase()))
    },
  }
}

const providers = {
  spotify: fake('spotify', [S.A, S.B, S.C, S.D], { s1: { name: 'Night Drive', tracks: [S.A, S.B] }, s2: { name: 'Gym Rotation', tracks: [S.D] } }, Object.values(S)),
  tidal: fake('tidal', [T.A, T.E], { t1: { name: 'night drive', tracks: [T.A] } }, Object.values(T)),
}

let runSync: typeof import('../server/jobs/sync').runSync

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'crossfade-')), 'test.db')
  const { useDb } = await import('../server/utils/db')
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  migrate(useDb(), { migrationsFolder: resolve('server/db/migrations') })
  runSync = (await import('../server/jobs/sync')).runSync
})

const byTitle = (c: CollectionDiff | undefined) =>
  Object.fromEntries((c?.rows ?? []).map(r => [(r.spotify ?? r.tidal)!.title, { state: r.state, target: r.target, method: r.method, reason: r.reason, candidate: r.candidate?.title }]))

describe('dry-run sync', () => {
  let first: CollectionDiff[]

  it('plans the union merge for liked songs', async () => {
    first = await runSync(() => {}, providers)
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
    const second = await runSync(() => {}, providers)
    expect(calls).toEqual([])
    expect(second.map(byTitle)).toEqual(first.map(byTitle))
  })
})
