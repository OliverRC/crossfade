// Oliver's decisions on what a pull would not settle by itself (docs/decisions/0005): conflicts and held collections.
// Each is stored as a change to main by `user`, so later pulls never ask again.
import { and, eq, isNull } from 'drizzle-orm'
import type { SnapshotItem } from '../../shared/types'
import { schema, useDb } from '../utils/db'
import { acquire, release } from './lock'
import { mergeCollection } from './pull'

export class DecisionError extends Error {}

export function resolveConflict(id: number, resolution: 'keep' | 'remove') {
  const db = useDb()
  const conflict = db.select().from(schema.conflicts).where(eq(schema.conflicts.id, id)).get()
  if (!conflict) throw new DecisionError('That conflict does not exist')
  if (conflict.resolvedAt) throw new DecisionError('That conflict is already decided')
  const at = new Date().toISOString()
  const state = resolution === 'keep' ? 'active' as const : 'removed' as const
  db.transaction((tx) => {
    tx.insert(schema.memberships).values({ collectionId: conflict.collectionId, canonicalTrackId: conflict.canonicalTrackId, state, changedAt: at, changedBy: 'user' })
      .onConflictDoUpdate({ target: [schema.memberships.collectionId, schema.memberships.canonicalTrackId], set: { state, changedAt: at, changedBy: 'user' } }).run()
    tx.update(schema.conflicts).set({ resolvedAt: at, resolution }).where(eq(schema.conflicts.id, id)).run()
  })
}

/**
 * accept: apply the removals the sanity guard held, from the read that tripped it.
 * keep / remove: for a playlist gone from the service, main keeps it (a push would recreate it there) or removes
 * its songs. Either way main stops tracking it on that service.
 */
export function resolveHold(id: number, action: 'accept' | 'keep' | 'remove') {
  const db = useDb()
  const hold = db.select().from(schema.pullHolds).where(eq(schema.pullHolds.id, id)).get()
  if (!hold) throw new DecisionError('That held collection does not exist')
  if (hold.resolvedAt) throw new DecisionError('That held collection is already decided')
  if ((hold.reason === 'gone') !== (action !== 'accept')) throw new DecisionError(hold.reason === 'gone' ? 'Choose keep or remove for a playlist that is gone' : 'Only accept applies here')
  if (!acquire('pull')) throw new DecisionError('A pull or cleanup is running; try again when it finishes')
  try {
    const link = db.select().from(schema.collectionLinks)
      .where(and(eq(schema.collectionLinks.collectionId, hold.collectionId), eq(schema.collectionLinks.provider, hold.provider))).get()
    if (action === 'accept') {
      const key = link?.providerCollectionId ?? 'liked'
      const checkpoint = db.select().from(schema.fetchCheckpoints).where(eq(schema.fetchCheckpoints.runId, hold.runId)).all()
        .find(c => c.provider === hold.provider && c.collectionKey === key)
      if (!checkpoint) throw new DecisionError('The read that was held is no longer saved; pull again')
      const canonical = new Map(db.select().from(schema.trackLinks).where(eq(schema.trackLinks.provider, hold.provider)).all()
        .filter(l => l.providerTrackId).map(l => [l.providerTrackId!, l.canonicalTrackId]))
      const items: SnapshotItem[] = checkpoint.tracks.flatMap(t => canonical.has(t.providerTrackId)
        ? [{ canonicalTrackId: canonical.get(t.providerTrackId)!, providerTrackId: t.providerTrackId, available: t.available !== false }]
        : [])
      mergeCollection({ provider: hold.provider, collectionId: hold.collectionId, providerCollectionId: link?.providerCollectionId ?? null, items, runId: hold.runId, acceptRemovals: true })
      return
    }

    const at = new Date().toISOString()
    db.transaction((tx) => {
      if (action === 'remove') {
        tx.update(schema.memberships).set({ state: 'removed', changedAt: at, changedBy: 'user' })
          .where(and(eq(schema.memberships.collectionId, hold.collectionId), eq(schema.memberships.state, 'active'))).run()
      }
      tx.delete(schema.snapshots).where(and(eq(schema.snapshots.provider, hold.provider), eq(schema.snapshots.collectionId, hold.collectionId))).run()
      if (link) tx.delete(schema.collectionLinks).where(eq(schema.collectionLinks.id, link.id)).run()
      tx.update(schema.pullHolds).set({ resolvedAt: at, resolution: action === 'keep' ? 'kept' : 'removed' })
        .where(and(eq(schema.pullHolds.id, id), isNull(schema.pullHolds.resolvedAt))).run()
    })
  } finally {
    release('pull')
  }
}
