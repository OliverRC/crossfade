import { describe, expect, it } from 'vitest'
import type { ProviderTrack } from '../shared/types'
import { normaliseText, splitTitle, versionKind } from '../server/core/normalise'
import { REVIEW_FLOOR, durationScore, pickIsrcResult, scoreMatch } from '../server/core/score'
import { isoDurationToMs } from '../server/core/duration'
import { type MatchSong, type MetadataMerge, cleanArtist, metadataMerges } from '../server/core/match'

const track = (over: Partial<ProviderTrack>): ProviderTrack => ({
  providerTrackId: 'x', isrc: null, title: 'Song', artists: ['Artist'], album: 'Album',
  durationMs: 200_000, explicit: false, version: null, ...over,
})

describe('normalisation', () => {
  it('lowercases, strips diacritics and punctuation, replaces &', () => {
    expect(normaliseText('Beyoncé & Jay-Z!')).toBe('beyonce and jay z')
  })

  it('splits bracketed and dashed version tags', () => {
    expect(splitTitle('Here Comes the Sun - Remastered 2009')).toEqual({ base: 'here comes the sun', version: 'remastered 2009', featured: [] })
    expect(splitTitle('Lanterns (2024 Remaster)').version).toBe('2024 remaster')
    expect(splitTitle('Roads (Live)').version).toBe('live')
  })

  it('keeps non-version brackets in the title', () => {
    expect(splitTitle('Interlude (Part II)').base).toBe('interlude part ii')
  })

  it('pulls featured artists out of the title', () => {
    expect(splitTitle('Stay (feat. Mira Solace & Kei)')).toEqual({ base: 'stay', version: null, featured: ['mira solace', 'kei'] })
    expect(splitTitle('Stay ft. Mira Solace').featured).toEqual(['mira solace'])
  })

  it('classifies versions, treating remasters as the original', () => {
    expect(versionKind('2011 remaster')).toBe('original')
    expect(versionKind('live at wembley')).toBe('live')
    expect(versionKind('kygo remix')).toBe('remix')
  })
})

describe('scoring fixtures', () => {
  it('remaster vs original lands in review, not auto-link territory', () => {
    const s = scoreMatch(track({ title: 'Lanterns', artists: ['Kei Tanabe'], durationMs: 245_000 }),
      track({ title: 'Lanterns', version: '2024 Remaster', artists: ['Kei Tanabe'], durationMs: 246_000 }))
    expect(s.score).toBeGreaterThanOrEqual(REVIEW_FLOOR)
    expect(s.versionMismatch).toBe(false)
  })

  it('featured artist in title on one side and in artists on the other', () => {
    const s = scoreMatch(track({ title: 'Stay (feat. Mira Solace)', artists: ['Halcyon Drift'] }),
      track({ title: 'Stay', artists: ['Halcyon Drift', 'Mira Solace'] }))
    expect(s.score).toBeGreaterThan(0.9)
  })

  it('live vs studio is capped below the review floor', () => {
    const s = scoreMatch(track({ title: 'Undertow' }), track({ title: 'Undertow - Live' }))
    expect(s.versionMismatch).toBe(true)
    expect(s.score).toBeLessThan(REVIEW_FLOOR)
  })

  it('identical titles by different artists score below the floor', () => {
    const s = scoreMatch(track({ title: 'Home', artists: ['Edward Sharpe'], durationMs: 303_000 }),
      track({ title: 'Home', artists: ['Michael Bublé'], durationMs: 225_000 }))
    expect(s.score).toBeLessThan(REVIEW_FLOOR)
  })

  it('non-Latin titles compare by characters', () => {
    const s = scoreMatch(track({ title: '夜に駆ける', artists: ['YOASOBI'] }), track({ title: '夜に駆ける', artists: ['YOASOBI'] }))
    expect(s.score).toBe(1)
  })

  it('explicit mismatch costs 0.05', () => {
    expect(scoreMatch(track({}), track({ explicit: true })).score).toBe(0.95)
  })

  it('duration falls linearly from 2s to 10s', () => {
    expect(durationScore(0, 2000)).toBe(1)
    expect(durationScore(0, 6000)).toBe(0.5)
    expect(durationScore(0, 10_000)).toBe(0)
  })
})

describe('ISRC tie-break', () => {
  it('prefers same album, then explicit flag, then closest duration', () => {
    const source = track({ album: 'Glass Horizon', explicit: true, durationMs: 238_000 })
    const results = [
      track({ providerTrackId: 'compilation', album: 'Hits', explicit: true, durationMs: 238_000 }),
      track({ providerTrackId: 'clean', album: 'Glass Horizon', explicit: false, durationMs: 238_000 }),
      track({ providerTrackId: 'album', album: 'Glass Horizon', explicit: true, durationMs: 239_000 }),
    ]
    expect(pickIsrcResult(source, results)?.providerTrackId).toBe('album')
  })
})

describe('ISO durations', () => {
  it('parses Tidal durations', () => {
    expect(isoDurationToMs('PT3M58S')).toBe(238_000)
    expect(isoDurationToMs('PT1H2M3.5S')).toBe(3_723_500)
    expect(isoDurationToMs('garbage')).toBe(0)
  })
})

describe('metadata matching (decision 0008)', () => {
  const song = (id: number, providers: ('spotify' | 'tidal')[], over: Partial<MatchSong> = {}): MatchSong =>
    ({ id, title: 'Always', version: null, artists: ['Gavin James'], durationMs: 200_000, providers, ...over })

  const cases: { name: string, songs: MatchSong[], merges: MetadataMerge[] }[] = [
    { name: 'same song, different ISRC on each service', songs: [song(1, ['spotify']), song(2, ['tidal'])], merges: [{ keep: 1, merge: [2] }] },
    { name: 'single on one service, album on the other, both already linked both ways', songs: [song(1, ['spotify', 'tidal']), song(2, ['spotify', 'tidal'])], merges: [{ keep: 1, merge: [2] }] },
    { name: 'keeps the song on more services', songs: [song(1, ['tidal']), song(2, ['spotify', 'tidal'])], merges: [{ keep: 2, merge: [1] }] },
    { name: 'version spelled differently ("- Remastered" vs "(Remastered)")', songs: [song(1, ['spotify'], { title: 'Such Great Heights - Remastered' }), song(2, ['tidal'], { title: 'Such Great Heights (Remastered)' })], merges: [{ keep: 1, merge: [2] }] },
    { name: 'featured artists in the title or the artist list', songs: [song(1, ['spotify'], { title: 'Genius', artists: ['LSD', 'Sia'] }), song(2, ['tidal'], { title: 'Genius (feat. Sia)', artists: ['LSD'] })], merges: [{ keep: 1, merge: [2] }] },
    { name: 'case, accents and punctuation', songs: [song(1, ['spotify'], { title: 'did you/fall apart' }), song(2, ['tidal'], { title: 'Did You / Fall Apart' })], merges: [{ keep: 1, merge: [2] }] },
    { name: 'within 2 seconds', songs: [song(1, ['spotify']), song(2, ['tidal'], { durationMs: 202_000 })], merges: [{ keep: 1, merge: [2] }] },
    { name: 'more than 2 seconds apart', songs: [song(1, ['spotify']), song(2, ['tidal'], { durationMs: 202_001 })], merges: [] },
    { name: "Tidal's separate version field counts", songs: [song(1, ['spotify']), song(2, ['tidal'], { version: 'Live' })], merges: [] },
    { name: 'different versions', songs: [song(1, ['spotify'], { title: 'Mine - Radio Edit' }), song(2, ['tidal'], { title: 'Mine' })], merges: [] },
    { name: 'different artists', songs: [song(1, ['spotify']), song(2, ['tidal'], { artists: ['Someone Else'] })], merges: [] },
    { name: 'two copies only one service holds stay apart', songs: [song(1, ['tidal']), song(2, ['tidal'])], merges: [] },
    { name: 'two copies on one service matching one on the other is ambiguous', songs: [song(1, ['spotify']), song(2, ['tidal']), song(3, ['tidal'])], merges: [] },
    { name: 'an artist credited on one service and named only in the title on the other', songs: [song(1, ['spotify'], { title: 'Mine - Bazzi vs. Eden Prince Remix', artists: ['Bazzi vs.', 'Eden Prince'] }), song(2, ['tidal'], { title: 'Mine (Bazzi vs. Eden Prince Remix)', artists: ['Bazzi'] })], merges: [{ keep: 1, merge: [2] }] },
    { name: 'an extra artist the other title does not name', songs: [song(1, ['spotify'], { artists: ['Gavin James', 'Someone Else'] }), song(2, ['tidal'])], merges: [] },
    { name: 'no artist in common, even if named in the title', songs: [song(1, ['spotify'], { title: 'Always (Eden Prince Remix)', artists: ['Eden Prince'] }), song(2, ['tidal'], { title: 'Always (Eden Prince Remix)', artists: ['Gavin James'] })], merges: [] },
    { name: 'songs with no title never match', songs: [song(1, ['spotify'], { title: '' }), song(2, ['tidal'], { title: '' })], merges: [] },
    { name: 'lengths do not drift along a chain', songs: [song(1, ['spotify']), song(2, ['tidal'], { durationMs: 201_500 }), song(3, ['tidal'], { durationMs: 203_000 })], merges: [{ keep: 1, merge: [2] }] },
  ]
  it.each(cases)('$name', ({ songs, merges }) => {
    expect(metadataMerges(songs)).toEqual(merges)
  })

  it('artist order does not matter', () => {
    expect(metadataMerges([song(1, ['spotify'], { artists: ['B', 'A'] }), song(2, ['tidal'], { artists: ['a', 'b'] })])).toEqual([{ keep: 1, merge: [2] }])
  })

  it('cleans joining words off artist names', () => {
    expect(cleanArtist('Bazzi vs.')).toBe('bazzi')
    expect(cleanArtist('Jay-Z &')).toBe('jay z')
    expect(cleanArtist('Max')).toBe('max')
  })
})
