import { describe, expect, it } from 'vitest'
import { findDuplicates, mergePlan, missingFrom, type PlaylistItems } from '../server/core/duplicates'

const p = (id: string, name: string, items: string): PlaylistItems => ({ id, name, items: items ? items.split(' ') : [] })
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`).join(' ')

describe('duplicate tiers', () => {
  const cases: { name: string, playlists: PlaylistItems[], expected: { tier: string, copies: string[] } | null }[] = [
    { name: 'identical copies → exact', playlists: [p('a', 'Alt Tunes', 'x y z'), p('b', 'Alt Tunes', 'x y z')], expected: { tier: 'exact', copies: ['a', 'b'] } },
    { name: 'names differ only in case, spacing and punctuation → same group', playlists: [p('a', 'ASOT Favs', 'x'), p('b', ' asot favs!', 'x')], expected: { tier: 'exact', copies: ['a', 'b'] } },
    { name: '10 shared of 11 (Emo) → exact', playlists: [p('a', 'Emo', range(1, 10)), p('b', 'Emo', range(1, 11))], expected: { tier: 'exact', copies: ['b', 'a'] } },
    { name: 'smaller copy fully inside the larger, under 90% of it (Heavy 9/7) → contained', playlists: [p('a', 'Heavy', range(1, 7)), p('b', 'Heavy', range(1, 9))], expected: { tier: 'contained', copies: ['b', 'a'] } },
    { name: 'little overlap (Lo-Fi Beats) → different', playlists: [p('a', 'Lo-Fi', range(1, 10)), p('b', 'Lo-Fi', range(8, 20))], expected: { tier: 'different', copies: ['b', 'a'] } },
    { name: 'same contents, different names → not a duplicate', playlists: [p('a', 'Alt Tunes', 'x y'), p('b', 'Light Alt Tunes', 'x y')], expected: null },
    { name: 'a small playlist inside a big one with another name → not a duplicate', playlists: [p('a', 'Progressive EDM', 't1 t2'), p('b', 'Olis Bangers', range(1, 90))], expected: null },
    { name: 'repeats within a copy do not dilute the match', playlists: [p('a', 'Eminem', 'x x x y'), p('b', 'Eminem', 'x y')], expected: { tier: 'exact', copies: ['a', 'b'] } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const [group] = findDuplicates(c.playlists).groups
      if (!c.expected) return expect(group).toBeUndefined()
      expect(group?.tier).toBe(c.expected.tier)
      expect(group?.copies.map(x => x.id)).toEqual(c.expected.copies)
    })
  }

  it('offers empty playlists for removal and keeps them out of name groups (Evo X)', () => {
    const report = findDuplicates([p('a', 'Evo X', 'x y z'), p('b', 'Evo X', ''), p('c', 'Unused', '')])
    expect(report.empty.map(e => e.id)).toEqual(['b', 'c'])
    expect(report.groups).toEqual([])
  })

  it('groups three copies and orders tiers exact, contained, different', () => {
    const report = findDuplicates([
      p('d1', 'Different', 'a b'), p('d2', 'Different', 'c d'),
      p('c1', 'Contained', range(1, 7)), p('c2', 'Contained', range(1, 9)),
      p('e1', 'Exact', 'x y'), p('e2', 'Exact', 'x y'), p('e3', 'Exact', 'x y'),
    ])
    expect(report.groups.map(g => [g.name, g.tier, g.copies.length])).toEqual([['Exact', 'exact', 3], ['Contained', 'contained', 2], ['Different', 'different', 2]])
  })
})

describe('merge plan', () => {
  it('adds what the kept copy lacks, in order, and the union covers every copy', () => {
    const plan = mergePlan([p('a', 'Emo', 't1 t2 t3'), p('b', 'Emo', 't1 t4 t2 t5')], 'a')
    expect(plan.add).toEqual(['t4', 't5'])
    expect(plan.spares.map(s => s.id)).toEqual(['b'])
    expect(missingFrom([...plan.keeper.items, ...plan.add], plan.union)).toEqual([])
  })

  it('keeping the larger copy adds nothing when it already holds everything', () => {
    expect(mergePlan([p('a', 'Emo', 't1 t2'), p('b', 'Emo', 't1 t2 t3')], 'b').add).toEqual([])
  })

  it('reports what is missing', () => {
    expect(missingFrom(['t1'], ['t1', 't2', 't2', 't3'])).toEqual(['t2', 't3'])
  })
})
