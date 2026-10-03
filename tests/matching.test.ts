import { describe, expect, it } from 'vitest'
import type { ProviderTrack } from '../shared/types'
import { normaliseText, splitTitle, versionKind } from '../server/core/normalise'
import { REVIEW_FLOOR, durationScore, pickIsrcResult, scoreMatch } from '../server/core/score'
import { isoDurationToMs } from '../server/core/duration'

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
