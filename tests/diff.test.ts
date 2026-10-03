import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../shared/types'
import { diffCollection, type LinkInfo } from '../server/core/diff'

const links = (map: Record<string, LinkInfo>) => (id: number, p: ProviderId) => map[`${id}:${p}`]

describe('bootstrap diff (union merge)', () => {
  const cases: { name: string, spotify: number[] | null, tidal: number[] | null, link?: LinkInfo, expected: { state: string, target?: ProviderId } }[] = [
    { name: 'on both sides → in sync', spotify: [1], tidal: [1], expected: { state: 'in_sync' } },
    { name: 'Spotify only, matched on Tidal → add to Tidal', spotify: [1], tidal: [], link: { status: 'matched', method: 'isrc' }, expected: { state: 'add', target: 'tidal' } },
    { name: 'Tidal only, matched on Spotify → add to Spotify', spotify: [], tidal: [1], link: { status: 'matched', method: 'isrc' }, expected: { state: 'add', target: 'spotify' } },
    { name: 'fuzzy candidate → review', spotify: [1], tidal: [], link: { status: 'review', confidence: 0.82 }, expected: { state: 'review', target: 'tidal' } },
    { name: 'no counterpart → unmatched', spotify: [1], tidal: [], link: { status: 'unmatched', reason: 'not_found' }, expected: { state: 'unmatched', target: 'tidal' } },
    { name: 'never checked → unmatched', spotify: [1], tidal: [], expected: { state: 'unmatched', target: 'tidal' } },
    { name: 'ignored → unmatched', spotify: [1], tidal: [], link: { status: 'ignored', reason: 'ignored' }, expected: { state: 'unmatched', target: 'tidal' } },
    { name: 'playlist missing on Tidal, matched → add (playlist created first)', spotify: [1], tidal: null, link: { status: 'matched' }, expected: { state: 'add', target: 'tidal' } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const target = c.expected.target ?? 'tidal'
      const [row] = diffCollection({
        spotify: c.spotify && new Set(c.spotify),
        tidal: c.tidal && new Set(c.tidal),
        linkOn: links(c.link ? { [`1:${target}`]: c.link } : {}),
      })
      expect(row).toMatchObject({ canonicalTrackId: 1, ...c.expected })
    })
  }

  it('never plans a removal and orders review, add, unmatched, in sync', () => {
    const rows = diffCollection({
      spotify: new Set([1, 2, 3, 4]),
      tidal: new Set([1]),
      linkOn: links({ '2:tidal': { status: 'unmatched' }, '3:tidal': { status: 'matched' }, '4:tidal': { status: 'review' } }),
    })
    expect(rows.map(r => r.state)).toEqual(['review', 'add', 'unmatched', 'in_sync'])
  })
})
