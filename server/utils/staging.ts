// Staging (docs/decisions/0007): pick which of the changes waiting for a service go out with its next push.
// Changes are derived from main and each service's snapshot; only the picks are stored. A pick whose change no longer
// exists (a pull found the service already matches, or main changed) is stale and is pruned.
import { and, eq, inArray } from 'drizzle-orm'
import type { ProviderId, StagedTrackView, StagedView, TrackView } from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import { status, type Change } from '../core/status'
import { spotifyLookupBudget } from './config'
import { schema, useDb } from './db'
import { collectionInputs } from './library'

export interface ChangeFilter {
  /** One collection, or every collection. */
  collectionId?: number
  /** One song in that collection. */
  canonicalTrackId?: number
  provider?: ProviderId
  change?: Change
}

interface PendingChange { collectionId: number, canonicalTrackId: number, provider: ProviderId, change: Change, staged: boolean }

/** Every change a push would make right now, with whether it is staged. */
function pendingChanges(filter: ChangeFilter = {}): PendingChange[] {
  const out: PendingChange[] = []
  for (const { collection, input } of collectionInputs()) {
    if (filter.collectionId !== undefined && collection.id !== filter.collectionId) continue
    for (const row of status(input).rows) {
      if (filter.canonicalTrackId !== undefined && row.canonicalTrackId !== filter.canonicalTrackId) continue
      for (const provider of PROVIDERS) {
        const change = row.change[provider]
        if (!change || (filter.provider && provider !== filter.provider) || (filter.change && change !== filter.change)) continue
        out.push({ collectionId: collection.id, canonicalTrackId: row.canonicalTrackId, provider, change, staged: row.staged[provider] })
      }
    }
  }
  return out
}

/** The staged changes that still exist for one service: what its next push sends. */
export function stagedChanges(provider: ProviderId): { collectionId: number, canonicalTrackId: number, change: Change }[] {
  return pendingChanges({ provider }).filter(c => c.staged).map(({ collectionId, canonicalTrackId, change }) => ({ collectionId, canonicalTrackId, change }))
}

/** Stage or unstage every current change matching the filter. Returns how many changed. */
export function setStaged(filter: ChangeFilter, staged: boolean): number {
  const db = useDb()
  const at = new Date().toISOString()
  const targets = pendingChanges(filter).filter(c => c.staged !== staged)
  db.transaction((tx) => {
    for (const c of targets) {
      const key = and(eq(schema.stagedChanges.collectionId, c.collectionId), eq(schema.stagedChanges.canonicalTrackId, c.canonicalTrackId), eq(schema.stagedChanges.provider, c.provider))
      if (staged) {
        tx.insert(schema.stagedChanges).values({ collectionId: c.collectionId, canonicalTrackId: c.canonicalTrackId, provider: c.provider, change: c.change, stagedAt: at })
          .onConflictDoUpdate({ target: [schema.stagedChanges.collectionId, schema.stagedChanges.canonicalTrackId, schema.stagedChanges.provider], set: { change: c.change, stagedAt: at } }).run()
      } else {
        tx.delete(schema.stagedChanges).where(key).run()
      }
    }
  })
  return targets.length
}

/** Drop picks whose change no longer exists. Returns how many were dropped. */
export function pruneStaged(): number {
  const db = useDb()
  const live = new Set(pendingChanges().filter(c => c.staged).map(c => `${c.collectionId}:${c.canonicalTrackId}:${c.provider}`))
  const stale = db.select().from(schema.stagedChanges).all().filter(s => !live.has(`${s.collectionId}:${s.canonicalTrackId}:${s.provider}`))
  if (stale.length) db.delete(schema.stagedChanges).where(inArray(schema.stagedChanges.id, stale.map(s => s.id))).run()
  return stale.length
}

/** What the next push to each service would do: staged adds and removals per collection. */
export function stagedView(): StagedView {
  const db = useDb()
  const inputs = collectionInputs()
  const staged = pendingChanges().filter(c => c.staged)
  const ids = [...new Set(staged.map(c => c.canonicalTrackId))]
  const tracks = new Map(ids.length
    ? db.select().from(schema.canonicalTracks).where(inArray(schema.canonicalTracks.id, ids)).all().map(t => [t.id, t])
    : [])
  const picks = new Map(db.select().from(schema.stagedChanges).all().map(r => [`${r.collectionId}:${r.canonicalTrackId}:${r.provider}`, r]))
  const track = (c: PendingChange): StagedTrackView => {
    const t = tracks.get(c.canonicalTrackId)
    const pick = picks.get(`${c.collectionId}:${c.canonicalTrackId}:${c.provider}`)
    return {
      canonicalTrackId: c.canonicalTrackId, title: t?.title || 'Unknown song', artists: t?.artists ?? [], durationMs: t?.durationMs ?? 0, isrc: t?.isrc ?? null,
      error: pick?.lastError ?? null, attempts: pick?.attempts ?? 0,
    }
  }
  const byTitle = (a: TrackView, b: TrackView) => a.title.localeCompare(b.title)

  return Object.fromEntries(PROVIDERS.map((provider) => {
    const mine = staged.filter(c => c.provider === provider)
    const collections = inputs
      .filter(x => mine.some(c => c.collectionId === x.collection.id))
      .map(({ collection, links }) => {
        const here = mine.filter(c => c.collectionId === collection.id)
        const link = links.find(l => l.provider === provider)
        return {
          key: String(collection.id),
          kind: collection.kind,
          name: collection.name,
          // A playlist push would have to create on the service first.
          createsPlaylist: collection.kind === 'playlist' && !link,
          ownerName: link?.access === 'collaborative' ? link.ownerName : null,
          add: here.filter(c => c.change === 'add').map(track).sort(byTitle),
          remove: here.filter(c => c.change === 'remove').map(track).sort(byTitle),
        }
      })
      .sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked') || a.name.localeCompare(b.name))
    const adds = mine.filter(c => c.change === 'add').map(c => c.canonicalTrackId)
    const known = new Set(adds.length
      ? db.select({ id: schema.trackLinks.canonicalTrackId }).from(schema.trackLinks)
        .where(and(eq(schema.trackLinks.provider, provider), eq(schema.trackLinks.status, 'matched'), inArray(schema.trackLinks.canonicalTrackId, adds))).all()
        .map(l => l.id)
      : [])
    return [provider, {
      collections,
      add: adds.length,
      remove: mine.filter(c => c.change === 'remove').length,
      needsLookup: new Set(adds.filter(id => !known.has(id))).size,
      lookupBudget: provider === 'spotify' ? spotifyLookupBudget() : null,
    }]
  })) as StagedView
}
