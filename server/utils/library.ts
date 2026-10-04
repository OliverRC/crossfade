// The Library page: main compared with each service's last pull, per collection (docs/decisions/0005).
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { CollectionStatusView, LibraryView, ProviderId, RunStatus, StatusCounts, StatusRowView } from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import type { MainEntry } from '../core/pull'
import { normaliseText } from '../core/normalise'
import { rowState, status, type Change, type StatusInput } from '../core/status'
import { schema, useDb } from './db'

const zero = () => ({ spotify: 0, tidal: 0 })
const emptyCounts = (): StatusCounts => ({ inSync: 0, conflicts: 0, add: zero(), remove: zero(), unavailable: zero(), staged: { add: zero(), remove: zero() }, addUnavailable: zero() })

/** Main and each service's last pull for one collection: what status compares. */
export interface CollectionInput {
  collection: typeof schema.collections.$inferSelect
  links: (typeof schema.collectionLinks.$inferSelect)[]
  holds: (typeof schema.pullHolds.$inferSelect)[]
  input: StatusInput
}

/** Every collection worth showing, with its status input. */
export function collectionInputs(): CollectionInput[] {
  const db = useDb()
  const collections = db.select().from(schema.collections).all()
  const links = db.select().from(schema.collectionLinks).all()
  const snapshots = db.select().from(schema.snapshots).all()
  const memberships = db.select().from(schema.memberships).all()
  const openConflicts = db.select().from(schema.conflicts).where(isNull(schema.conflicts.resolvedAt)).all()
  const openHolds = db.select().from(schema.pullHolds).where(isNull(schema.pullHolds.resolvedAt)).all()
  const staged = db.select().from(schema.stagedChanges).all()
  const pulled = Object.fromEntries(PROVIDERS.map(p => [p, snapshots.some(s => s.provider === p)])) as Record<ProviderId, boolean>

  const out: CollectionInput[] = []
  for (const c of collections) {
    const main = new Map<number, MainEntry>(memberships.filter(m => m.collectionId === c.id).map(m => [m.canonicalTrackId, { state: m.state, changedAt: m.changedAt, changedBy: m.changedBy }]))
    const own = links.filter(l => l.collectionId === c.id)
    const holds = openHolds.filter(h => h.collectionId === c.id)
    const followedOn = (p: ProviderId) => own.some(l => l.provider === p && l.access === 'followed')
    // A followed playlist with no copy anywhere readable has no songs in main, but is still listed.
    if (!main.size && !holds.length && !PROVIDERS.some(followedOn)) continue
    const sides = Object.fromEntries(PROVIDERS.map((p) => {
      const snap = snapshots.find(s => s.provider === p && s.collectionId === c.id)
      return [p, { pulled: pulled[p], items: snap ? new Map(snap.items.map(i => [i.canonicalTrackId, i.available])) : null, followed: followedOn(p) }]
    })) as StatusInput['sides']
    const picked = new Map<number, Partial<Record<ProviderId, Change>>>()
    for (const s of staged.filter(x => x.collectionId === c.id)) picked.set(s.canonicalTrackId, { ...picked.get(s.canonicalTrackId), [s.provider]: s.change })
    out.push({
      collection: c,
      links: own,
      holds,
      input: {
        main,
        sides,
        conflicts: new Map(openConflicts.filter(x => x.collectionId === c.id).map(x => [x.canonicalTrackId, { provider: x.provider, change: x.change }])),
        staged: picked,
      },
    })
  }
  return out
}

export function libraryView(selectedKey?: string): LibraryView {
  const db = useDb()
  const openConflicts = db.select().from(schema.conflicts).where(isNull(schema.conflicts.resolvedAt)).all()
  const all = collectionInputs()
  const inputs = new Map<number, StatusInput>()
  const views: CollectionStatusView[] = []
  const totals = { ...emptyCounts(), held: all.reduce((n, x) => n + x.holds.length, 0) }
  for (const { collection: c, links: own, holds, input } of all) {
    inputs.set(c.id, input)
    const { counts } = status(input)
    for (const p of PROVIDERS) {
      totals.add[p] += counts.add[p]
      totals.remove[p] += counts.remove[p]
      totals.unavailable[p] += counts.unavailable[p]
      totals.staged.add[p] += counts.staged.add[p]
      totals.staged.remove[p] += counts.staged.remove[p]
      totals.addUnavailable[p] += counts.addUnavailable[p]
    }
    totals.inSync += counts.inSync
    totals.conflicts += counts.conflicts
    views.push({
      key: String(c.id),
      kind: c.kind,
      name: c.name,
      on: Object.fromEntries(PROVIDERS.map(p => [p, own.some(l => l.provider === p && l.access !== 'followed')])) as Record<ProviderId, boolean>,
      shared: Object.fromEntries(own.filter(l => l.access !== 'owned').map(l => [l.provider, { access: l.access as 'collaborative' | 'followed', ownerName: l.ownerName }])),
      counts,
      songs: [...input.main.values()].filter(m => m.state === 'active').length,
      namesakes: [],
      holds: holds.map(h => ({ id: h.id, provider: h.provider, reason: h.reason, before: h.before, removing: h.removing, detectedAt: h.detectedAt, runId: h.runId })),
    })
  }
  const byName = Map.groupBy(views.filter(v => v.kind === 'playlist'), v => normaliseText(v.name))
  for (const v of views) {
    v.namesakes = (byName.get(normaliseText(v.name)) ?? []).filter(o => o !== v).map(o => ({ key: o.key, on: o.on, songs: o.songs }))
  }
  views.sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked') || a.name.localeCompare(b.name))

  const selected = views.find(v => v.key === selectedKey) ?? views[0]
  let rows: StatusRowView[] = []
  if (selected) {
    const input = inputs.get(Number(selected.key))!
    const result = status(input).rows
    const tracks = new Map(result.length
      ? db.select().from(schema.canonicalTracks).where(inArray(schema.canonicalTracks.id, result.map(r => r.canonicalTrackId))).all().map(t => [t.id, t])
      : [])
    const conflictIds = new Map(openConflicts.filter(x => x.collectionId === Number(selected.key)).map(x => [x.canonicalTrackId, x.id]))
    rows = result.map((r) => {
      const t = tracks.get(r.canonicalTrackId)
      return {
        canonicalTrackId: r.canonicalTrackId,
        state: rowState(r),
        track: { title: t?.title ?? 'Unknown', artists: t?.artists ?? [], durationMs: t?.durationMs ?? 0, isrc: t?.isrc ?? null },
        main: r.main,
        spotify: r.spotify,
        tidal: r.tidal,
        conflict: r.conflict ? { id: conflictIds.get(r.canonicalTrackId)!, ...r.conflict } : null,
        change: r.change,
        staged: r.staged,
      }
    })
  }

  return {
    services: Object.fromEntries(PROVIDERS.map(p => [p, serviceStatus(p)])) as LibraryView['services'],
    collections: views,
    totals,
    selected: selected ? { key: selected.key, rows } : null,
    recent: db.select({ counts: schema.syncRuns.counts }).from(schema.syncRuns).where(eq(schema.syncRuns.kind, 'pull'))
      .orderBy(desc(schema.syncRuns.id)).limit(20).all().reverse().map(r => (r.counts?.added ?? 0) + (r.counts?.removed ?? 0)),
  }
}

function serviceStatus(provider: ProviderId) {
  const db = useDb()
  const runs = db.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.kind, 'pull'), eq(schema.syncRuns.provider, provider))).orderBy(desc(schema.syncRuns.id)).limit(20).all()
  const latest = runs[0]
  const run: RunStatus | null = latest ? { id: latest.id, status: latest.status, phase: latest.phase, pause: latest.pause, error: latest.error } : null
  return { pulledAt: runs.find(r => r.status === 'succeeded')?.finishedAt ?? null, run }
}
