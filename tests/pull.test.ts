import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../shared/types'
import { pull, type MainEntry, type PullChange } from '../server/core/pull'
import { status, type StatusSide } from '../server/core/status'

const T0 = '2026-10-01T00:00:00Z' // both services pulled
const T1 = '2026-10-02T00:00:00Z' // something changed main
const active = (by: ProviderId | 'user' = 'spotify', at = T0): MainEntry => ({ state: 'active', changedAt: at, changedBy: by })
const removed = (by: ProviderId | 'user' = 'spotify', at = T0): MainEntry => ({ state: 'removed', changedAt: at, changedBy: by })
const set = (...ids: number[]) => new Set(ids)
const base = (...ids: number[]) => ({ items: set(...ids), takenAt: T0 })
/** A song on both services that never changes, so emptying a collection does not trip the sanity guard. */
const STEADY = 99

/** Apply a pull's changes to main the way the pull job does. */
function apply(main: Map<number, MainEntry>, provider: ProviderId, changes: PullChange[], at: string) {
  for (const c of changes) {
    if (c.kind === 'add' || c.kind === 'confirm') main.set(c.canonicalTrackId, { state: 'active', changedAt: at, changedBy: provider })
    if (c.kind === 'remove') main.set(c.canonicalTrackId, { state: 'removed', changedAt: at, changedBy: provider })
  }
}

const side = (items: Record<number, boolean> | null): StatusSide => ({ pulled: true, items: items && new Map(Object.entries(items).map(([k, v]) => [Number(k), v])) })

// One case per row of the plan's diff table ("Diff rules for one track in one collection"), read one service at a time:
// each pulls its own change into main, and the status shows what a push would do.
describe('pull, row by row of the diff table', () => {
  interface Case {
    name: string
    /** Song 1 in main, and each service's snapshot before and contents now. */
    main: MainEntry | null
    spotify: { base: number[], now: number[] }
    tidal: { base: number[], now: number[] }
    /** Pull order. */
    order: ProviderId[]
    expected: { main: 'active' | 'removed' | null, conflict?: 'added' | 'removed', spotify: string, tidal: string }
  }
  const cases: Case[] = [
    { name: 'added on Spotify → in main, push adds it on Tidal', main: null, spotify: { base: [], now: [1] }, tidal: { base: [], now: [] }, order: ['spotify', 'tidal'], expected: { main: 'active', spotify: 'present', tidal: 'missing' } },
    { name: 'added on Tidal → in main, push adds it on Spotify', main: null, spotify: { base: [], now: [] }, tidal: { base: [], now: [1] }, order: ['spotify', 'tidal'], expected: { main: 'active', spotify: 'missing', tidal: 'present' } },
    { name: 'removed on Spotify → removed in main, push removes it on Tidal', main: active(), spotify: { base: [1], now: [] }, tidal: { base: [1], now: [1] }, order: ['spotify', 'tidal'], expected: { main: 'removed', spotify: 'absent', tidal: 'extra' } },
    { name: 'removed on Tidal → removed in main, push removes it on Spotify', main: active(), spotify: { base: [1], now: [1] }, tidal: { base: [1], now: [] }, order: ['tidal', 'spotify'], expected: { main: 'removed', spotify: 'extra', tidal: 'absent' } },
    { name: 'added on both → in main, nothing to push', main: null, spotify: { base: [], now: [1] }, tidal: { base: [], now: [1] }, order: ['spotify', 'tidal'], expected: { main: 'active', spotify: 'present', tidal: 'present' } },
    { name: 'removed on both → removed in main, nothing to push', main: active(), spotify: { base: [1], now: [] }, tidal: { base: [1], now: [] }, order: ['spotify', 'tidal'], expected: { main: 'removed', spotify: 'absent', tidal: 'absent' } },
    { name: 'removed on Spotify, added on Tidal → conflict, main unchanged', main: active(), spotify: { base: [1], now: [] }, tidal: { base: [], now: [1] }, order: ['tidal', 'spotify'], expected: { main: 'active', conflict: 'removed', spotify: 'missing', tidal: 'present' } },
    { name: 'present on Spotify, still missing on Tidal → push adds it on Tidal once found there', main: active(), spotify: { base: [1], now: [1] }, tidal: { base: [], now: [] }, order: ['spotify', 'tidal'], expected: { main: 'active', spotify: 'present', tidal: 'missing' } },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const main = new Map<number, MainEntry>([[STEADY, active()], ...(c.main ? [[1, c.main] as const] : [])])
      let conflict: 'added' | 'removed' | undefined
      c.order.forEach((p, i) => {
        const result = pull({ provider: p, now: set(STEADY, ...c[p].now), base: base(STEADY, ...c[p].base), main })
        expect(result.hold).toBeNull()
        conflict ??= result.changes.find(x => x.kind === 'conflict')?.change
        apply(main, p, result.changes, i ? '2026-10-03T12:00:00Z' : '2026-10-03T11:00:00Z')
      })
      expect(main.get(1)?.state ?? null).toBe(c.expected.main)
      expect(conflict).toBe(c.expected.conflict)
      if (!main.has(1)) return
      const { rows } = status({
        main,
        sides: { spotify: side(Object.fromEntries(c.spotify.now.map(id => [id, true]))), tidal: side(Object.fromEntries(c.tidal.now.map(id => [id, true]))) },
        conflicts: new Map(conflict ? [[1, { provider: 'spotify' as const, change: conflict }]] : []),
      })
      const row = rows.find(r => r.canonicalTrackId === 1)
      if (conflict) expect(row?.conflict).toEqual({ provider: 'spotify', change: conflict })
      const shown = row ? { spotify: row.spotify, tidal: row.tidal } : { spotify: 'absent', tidal: 'absent' }
      expect(shown).toEqual({ spotify: c.expected.spotify, tidal: c.expected.tidal })
    })
  }
})

describe('pull rules', () => {
  it('a first pull adds everything, and two first pulls give the union', () => {
    const main = new Map<number, MainEntry>()
    apply(main, 'spotify', pull({ provider: 'spotify', now: set(1, 2), base: null, main }).changes, T0)
    const tidal = pull({ provider: 'tidal', now: set(2, 3), base: null, main })
    expect(tidal.changes).toEqual([{ kind: 'add', canonicalTrackId: 3 }])
    apply(main, 'tidal', tidal.changes, T0)
    expect([...main.keys()].sort()).toEqual([1, 2, 3])
  })

  it('pulling again with nothing changed reports nothing', () => {
    const main = new Map([[1, active()], [2, active('tidal')]])
    expect(pull({ provider: 'spotify', now: set(1, 2), base: base(1, 2), main })).toEqual({ changes: [], hold: null })
  })

  it('an add on one service that main removed afterwards on the other is a conflict', () => {
    const main = new Map([[1, removed('tidal', T1)]])
    expect(pull({ provider: 'spotify', now: set(1), base: base(), main }).changes).toEqual([{ kind: 'conflict', canonicalTrackId: 1, change: 'added' }])
  })

  it('a removal older than main’s own change is applied, not a conflict, when this service made that change', () => {
    const main = new Map([[1, active('spotify', T1)], [STEADY, active()]])
    expect(pull({ provider: 'spotify', now: set(STEADY), base: base(1, STEADY), main }).changes).toEqual([{ kind: 'remove', canonicalTrackId: 1 }])
  })

  it('re-adding a song main removed before the last pull brings it back', () => {
    const main = new Map([[1, removed('tidal', '2026-09-01T00:00:00Z')]])
    expect(pull({ provider: 'spotify', now: set(1), base: base(), main }).changes).toEqual([{ kind: 'add', canonicalTrackId: 1 }])
  })

  it('an unavailable song still counts as held by the service, so it is not removed', () => {
    const main = new Map([[1, active()]])
    expect(pull({ provider: 'tidal', now: set(1), base: base(1), main }).changes).toEqual([])
  })
})

describe('sanity guard', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const mainOf = (ids: number[]) => new Map(ids.map(id => [id, active()]))

  it('holds a collection that comes back empty', () => {
    expect(pull({ provider: 'tidal', now: set(), base: base(1, 2), main: mainOf([1, 2]) })).toEqual({ changes: [], hold: { reason: 'empty', before: 2, removing: 2 } })
  })

  it('holds a read that would remove more than 10% and at least 5 songs', () => {
    const result = pull({ provider: 'tidal', now: set(...many(40)), base: base(...many(46)), main: mainOf(many(46)) })
    expect(result).toEqual({ changes: [], hold: { reason: 'mass_removal', before: 46, removing: 6 } })
  })

  it('lets 4 removals through even when they are more than 10%', () => {
    expect(pull({ provider: 'tidal', now: set(1), base: base(1, 2, 3, 4, 5), main: mainOf([1, 2, 3, 4, 5]) }).hold).toBeNull()
  })

  it('lets 5 removals through when they are 10% or less', () => {
    expect(pull({ provider: 'tidal', now: set(...many(45)), base: base(...many(50)), main: mainOf(many(50)) }).hold).toBeNull()
  })

  it('applies held removals once Oliver accepts them', () => {
    const result = pull({ provider: 'tidal', now: set(), base: base(1, 2), main: mainOf([1, 2]), acceptRemovals: true })
    expect(result.changes.map(c => c.kind)).toEqual(['remove', 'remove'])
  })

  it('never holds a first pull', () => {
    expect(pull({ provider: 'tidal', now: set(), base: null, main: new Map() }).hold).toBeNull()
  })
})

describe('status', () => {
  it('counts what each push would do, and marks unavailable and not-yet-pulled songs', () => {
    const main = new Map([[1, active()], [2, active()], [3, removed()], [4, active()]])
    const { rows, counts } = status({
      main,
      sides: { spotify: side({ 1: true, 2: true, 3: true, 4: true }), tidal: side({ 1: true, 4: false }) },
      conflicts: new Map(),
    })
    expect(Object.fromEntries(rows.map(r => [r.canonicalTrackId, `${r.spotify}/${r.tidal}`]))).toEqual({ 1: 'present/present', 2: 'present/missing', 3: 'extra/absent', 4: 'present/unavailable' })
    expect(counts).toEqual({ inSync: 1, conflicts: 0, add: { spotify: 0, tidal: 1 }, remove: { spotify: 1, tidal: 0 }, unavailable: { spotify: 0, tidal: 1 }, staged: { add: { spotify: 0, tidal: 0 }, remove: { spotify: 0, tidal: 0 } }, addUnavailable: { spotify: 0, tidal: 0 } })
  })

  it('marks a change staged only while the same change still exists', () => {
    const main = new Map([[1, active()], [2, active()], [3, removed()]])
    const { rows, counts } = status({
      main,
      sides: { spotify: side({ 1: true, 2: true, 3: true }), tidal: side({ 1: true }) },
      conflicts: new Map(),
      // 1: staged add, but Tidal already has it. 2: staged add, still missing. 3: staged as an add, but it is now a removal.
      staged: new Map([[1, { tidal: 'add' }], [2, { tidal: 'add' }], [3, { spotify: 'add' }]]),
    })
    const byId = new Map(rows.map(r => [r.canonicalTrackId, r]))
    expect(byId.get(1)).toMatchObject({ change: { spotify: null, tidal: null }, staged: { spotify: false, tidal: false } })
    expect(byId.get(2)).toMatchObject({ change: { spotify: null, tidal: 'add' }, staged: { spotify: false, tidal: true } })
    expect(byId.get(3)).toMatchObject({ change: { spotify: 'remove', tidal: null }, staged: { spotify: false, tidal: false } })
    expect(counts.staged).toEqual({ add: { spotify: 0, tidal: 1 }, remove: { spotify: 0, tidal: 0 } })
  })

  it('offers no change for a song in conflict', () => {
    const { rows } = status({
      main: new Map([[1, active()]]),
      sides: { spotify: side({}), tidal: side({ 1: true }) },
      conflicts: new Map([[1, { provider: 'spotify', change: 'removed' }]]),
      staged: new Map([[1, { spotify: 'add' }]]),
    })
    expect(rows[0]).toMatchObject({ change: { spotify: null, tidal: null }, staged: { spotify: false, tidal: false } })
  })

  it('shows a collection missing from a service as all to add, and an unpulled service as unknown', () => {
    const main = new Map([[1, active()]])
    expect(status({ main, sides: { spotify: side({ 1: true }), tidal: side(null) }, conflicts: new Map() }).rows[0]).toMatchObject({ tidal: 'missing' })
    expect(status({ main, sides: { spotify: side({ 1: true }), tidal: { pulled: false, items: null } }, conflicts: new Map() }).rows[0]).toMatchObject({ tidal: 'unknown' })
  })

  it('puts conflicts first and leaves settled removals out', () => {
    const main = new Map([[1, active()], [2, active()], [3, removed()]])
    const { rows, counts } = status({
      main,
      sides: { spotify: side({ 1: true, 2: true }), tidal: side({ 1: true, 2: true }) },
      conflicts: new Map([[2, { provider: 'spotify', change: 'removed' }]]),
    })
    expect(rows.map(r => r.canonicalTrackId)).toEqual([2, 1])
    expect(counts.conflicts).toBe(1)
  })
})
