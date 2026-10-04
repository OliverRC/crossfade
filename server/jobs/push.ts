// Push the changes staged for one service (docs/decisions/0007). The only code path that writes to a real library,
// apart from the Tidal playlist cleanup. Main is not changed: a push makes the service match main.
//
// 1. Find each song to add on the service: an earlier link, else by ISRC (recorded as a link).
// 2. Per collection, read the playlist again and write only what it still needs. Liked songs are not re-read
//    (thousands of songs, 20 per page); their writes are idempotent instead.
// 3. Per song: a success updates the service's snapshot (so status shows it in sync and the staged pick leaves);
//    a failure stays staged with its reason, for the next push.
import { and, eq, inArray } from 'drizzle-orm'
import type { ProviderId, PushProgress, PushStepProgress, SnapshotItem } from '../../shared/types'
import type { Change } from '../core/status'
import type { PlaylistEntry, PushWriter, WriteFailures } from '../providers/types'
import { schema, useDb } from '../utils/db'
import { stagedChanges } from '../utils/staging'
import { providerNames } from './quota'
import type { RunLog } from './run-log'

export interface PushCounts {
  added: number
  removed: number
  failed: number
  skipped: number
}

interface Item { canonicalTrackId: number, change: Change, isrc: string | null, title: string, trackId: string | null, error: string | null }
interface Group { collectionId: number, key: string, name: string, kind: 'liked' | 'playlist', playlistId: string | null, items: Item[] }

const now = () => new Date().toISOString()
const count = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`

/** Creating a playlist on the other service is M5 slice 4; until then those changes stay staged. */
export const CREATE_NOT_YET = 'Creating the playlist comes in a later step of M5; these stay staged until then'

export async function runPush(
  provider: ProviderId,
  writer: PushWriter,
  report: (progress: PushProgress) => void,
  log: RunLog,
): Promise<PushCounts> {
  const name = providerNames[provider]
  const counts: PushCounts = { added: 0, removed: 0, failed: 0, skipped: 0 }
  const groups = loadGroups(provider)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  if (!total) {
    log.event('info', null, `Nothing staged for ${name}`)
    return counts
  }

  // Progress per collection and step, shown on the push plans while this runs.
  const progress: PushProgress = { provider, collections: {} }
  for (const g of groups) {
    const step = (change: Change): PushStepProgress | undefined => {
      const n = g.items.filter(i => i.change === change).length
      return n ? { status: 'waiting', total: n, done: 0, failed: 0, detail: null } : undefined
    }
    progress.collections[g.key] = { name: g.name, add: step('add'), remove: step('remove') }
  }
  const emit = () => report(structuredClone(progress))
  emit()
  log.event('info', null, `Started by you: ${count(groups.flatMap(g => g.items).filter(i => i.change === 'add').length, 'add')} and ${count(groups.flatMap(g => g.items).filter(i => i.change === 'remove').length, 'removal')} on ${name}, in ${count(groups.length, 'collection')}`)

  // 1. Find songs to add on the service.
  const adds = groups.filter(g => g.playlistId || g.kind === 'liked').flatMap(g => g.items.filter(i => i.change === 'add'))
  log.stage('lookup', { status: 'running', done: 0, total: adds.length, detail: null })
  await resolveTrackIds(provider, writer, adds)
  const unresolved = adds.filter(i => !i.trackId).length
  log.stage('lookup', { status: 'done', done: adds.length, detail: unresolved ? `${count(adds.length - unresolved, 'song')} found, ${unresolved} not on ${name}` : `${count(adds.length, 'song')} found` })

  // 2. Write, one collection at a time.
  log.stage('write', { status: 'running', done: 0, total, detail: null })
  let written = 0
  for (const g of groups) {
    const steps = progress.collections[g.key]!
    log.stage('write', { detail: `"${g.name}"` })

    if (g.kind === 'playlist' && !g.playlistId) {
      for (const s of [steps.add, steps.remove]) if (s) Object.assign(s, { status: 'skipped', detail: CREATE_NOT_YET })
      counts.skipped += g.items.length
      log.event('info', 'write', `Skipped "${g.name}": not on ${name} yet. ${CREATE_NOT_YET}`)
      written += g.items.length
      log.stage('write', { done: written })
      emit()
      continue
    }

    // Read the playlist as it is now; liked songs rely on idempotent writes instead.
    let entries: PlaylistEntry[] | null = null
    if (g.playlistId) {
      entries = await writer.readPlaylist(g.playlistId)
      if (!entries) {
        const reason = `"${g.name}" is no longer on ${name}; pull ${name} to update main`
        for (const i of g.items) i.error = reason
        for (const s of [steps.add, steps.remove]) if (s) Object.assign(s, { status: 'failed', failed: s.total, detail: reason })
        settle(provider, g, [], g.items)
        counts.failed += g.items.length
        log.event('error', 'write', reason)
        written += g.items.length
        log.stage('write', { done: written })
        emit()
        continue
      }
    }

    for (const change of ['remove', 'add'] as const) {
      const step = steps[change]
      if (!step) continue
      const items = g.items.filter(i => i.change === change)
      step.status = 'running'
      emit()
      const ok = change === 'add'
        ? await writeAdds(writer, g, items, entries)
        : await writeRemoves(provider, writer, g, items, entries)
      const failed = items.filter(i => i.error).length
      Object.assign(step, { status: failed === items.length ? 'failed' : 'done', done: ok.length, failed, detail: failed ? firstError(items) : null })
      settle(provider, g, ok, items.filter(i => i.error))
      if (change === 'add') counts.added += ok.length
      else counts.removed += ok.length
      counts.failed += failed
      log.event(failed ? 'warn' : 'info', 'write', `${change === 'add' ? 'Added' : 'Removed'} ${count(ok.length, 'song')} ${change === 'add' ? 'to' : 'from'} "${g.name}" on ${name}${failed ? `; ${failed} failed: ${firstError(items)}` : ''}`)
      written += items.length
      log.stage('write', { done: written })
      emit()
    }
  }
  log.stage('write', { status: 'done', detail: `${counts.added} added, ${counts.removed} removed, ${counts.failed} failed, ${counts.skipped} waiting` })
  return counts
}

/** Staged changes for the service, grouped by collection, with what is known about each song. */
function loadGroups(provider: ProviderId): Group[] {
  const db = useDb()
  const changes = stagedChanges(provider)
  if (!changes.length) return []
  const collectionIds = [...new Set(changes.map(c => c.collectionId))]
  const collections = new Map(db.select().from(schema.collections).where(inArray(schema.collections.id, collectionIds)).all().map(c => [c.id, c]))
  const links = db.select().from(schema.collectionLinks).where(and(eq(schema.collectionLinks.provider, provider), inArray(schema.collectionLinks.collectionId, collectionIds))).all()
  const tracks = new Map(db.select().from(schema.canonicalTracks).where(inArray(schema.canonicalTracks.id, [...new Set(changes.map(c => c.canonicalTrackId))])).all().map(t => [t.id, t]))

  return collectionIds.map((id) => {
    const c = collections.get(id)!
    const link = links.find(l => l.collectionId === id && l.access !== 'followed')
    return {
      collectionId: id,
      key: String(id),
      name: c.name,
      kind: c.kind,
      playlistId: c.kind === 'playlist' ? link?.providerCollectionId ?? null : null,
      items: changes.filter(x => x.collectionId === id).map(x => ({
        canonicalTrackId: x.canonicalTrackId, change: x.change, isrc: tracks.get(x.canonicalTrackId)?.isrc ?? null,
        title: tracks.get(x.canonicalTrackId)?.title || 'Unknown song', trackId: null, error: null,
      })),
    }
  }).sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked') || a.name.localeCompare(b.name))
}

/** The service's track for each song to add: its preferred link, else an ISRC lookup, saved as a new link. */
async function resolveTrackIds(provider: ProviderId, writer: PushWriter, items: Item[]) {
  if (!items.length) return
  const db = useDb()
  const ids = [...new Set(items.map(i => i.canonicalTrackId))]
  const links = db.select().from(schema.trackLinks)
    .where(and(eq(schema.trackLinks.provider, provider), eq(schema.trackLinks.status, 'matched'), inArray(schema.trackLinks.canonicalTrackId, ids))).all()
    .filter(l => l.providerTrackId)
  const linked = new Map<number, string>()
  for (const l of [...links].sort((a, b) => Number(b.isPreferred) - Number(a.isPreferred))) {
    if (!linked.has(l.canonicalTrackId)) linked.set(l.canonicalTrackId, l.providerTrackId!)
  }

  const lookup = [...new Set(items.filter(i => !linked.has(i.canonicalTrackId) && i.isrc).map(i => i.isrc!))]
  const found = lookup.length ? await writer.findPlayableByIsrcs(lookup) : new Map<string, string>()
  db.transaction((tx) => {
    for (const id of ids) {
      if (linked.has(id)) continue
      const isrc = items.find(i => i.canonicalTrackId === id)!.isrc
      const trackId = isrc ? found.get(isrc) : undefined
      if (!trackId) continue
      // Another canonical song may already own this track ID (unique per service); reuse rather than collide.
      const owner = tx.select().from(schema.trackLinks).where(and(eq(schema.trackLinks.provider, provider), eq(schema.trackLinks.providerTrackId, trackId))).get()
      if (!owner) {
        tx.insert(schema.trackLinks).values({ canonicalTrackId: id, provider, providerTrackId: trackId, status: 'matched', method: 'isrc', confidence: 1, isPreferred: true, lastCheckedAt: now() }).run()
      }
      linked.set(id, trackId)
    }
  })

  const name = providerNames[provider]
  for (const i of items) {
    i.trackId = linked.get(i.canonicalTrackId) ?? null
    if (!i.trackId) i.error = i.isrc ? `Not found on ${name} by ISRC ${i.isrc}` : `No ISRC, so it cannot be found on ${name} automatically yet`
  }
}

/** Add what the collection still lacks. Returns the songs now there. */
async function writeAdds(writer: PushWriter, g: Group, items: Item[], entries: PlaylistEntry[] | null): Promise<Item[]> {
  const ready = items.filter(i => i.trackId)
  // Already in the playlist, by track or by ISRC (the same recording under another ID): nothing to write.
  const present = (i: Item) => entries?.some(e => e.trackId === i.trackId || (i.isrc && e.isrc === i.isrc)) ?? false
  const toWrite = ready.filter(i => !present(i))
  let failures: WriteFailures = new Map()
  if (toWrite.length) {
    const ids = [...new Set(toWrite.map(i => i.trackId!))]
    failures = g.playlistId ? await writer.addToPlaylist(g.playlistId, ids) : await writer.addLiked(ids)
  }
  for (const i of toWrite) {
    const why = failures.get(i.trackId!)
    if (why) i.error = why
  }
  return ready.filter(i => !i.error)
}

/** Remove every copy of each song from the collection. Returns the songs now gone. */
async function writeRemoves(provider: ProviderId, writer: PushWriter, g: Group, items: Item[], entries: PlaylistEntry[] | null): Promise<Item[]> {
  // The service's IDs for each song: what its last pull saw in this collection, plus any linked IDs.
  const db = useDb()
  const snapshot = db.select().from(schema.snapshots).where(and(eq(schema.snapshots.provider, provider), eq(schema.snapshots.collectionId, g.collectionId))).get()
  const links = db.select().from(schema.trackLinks).where(and(eq(schema.trackLinks.provider, provider), inArray(schema.trackLinks.canonicalTrackId, items.map(i => i.canonicalTrackId)))).all()
  const idsOf = (i: Item) => new Set([
    ...(snapshot?.items ?? []).filter(s => s.canonicalTrackId === i.canonicalTrackId).map(s => s.providerTrackId),
    ...links.filter(l => l.canonicalTrackId === i.canonicalTrackId && l.providerTrackId).map(l => l.providerTrackId!),
  ])

  if (g.playlistId) {
    const targets = new Map<Item, PlaylistEntry[]>()
    for (const i of items) {
      const ids = idsOf(i)
      targets.set(i, entries!.filter(e => ids.has(e.trackId) || (i.isrc && e.isrc === i.isrc)))
    }
    // Songs with no entry left are already gone: success without a write.
    const all = [...targets.values()].flat()
    const failures = all.length ? await writer.removeFromPlaylist(g.playlistId, all) : new Map<string, string>()
    for (const [i, es] of targets) {
      const why = es.map(e => failures.get(e.trackId)).find(Boolean)
      if (why) i.error = why
    }
  } else {
    const byId = new Map<string, Item>()
    for (const i of items) for (const id of idsOf(i)) byId.set(id, i)
    if (!byId.size) for (const i of items) i.error = 'Crossfade does not know this song\'s ID on the service; pull it first'
    const failures = byId.size ? await writer.removeLiked([...byId.keys()]) : new Map<string, string>()
    for (const [id, why] of failures) byId.get(id)!.error = why
  }
  return items.filter(i => !i.error)
}

/**
 * Record what a write did: songs that succeeded go into (or out of) the service's snapshot and leave the stage;
 * songs that failed stay staged with their reason.
 */
function settle(provider: ProviderId, g: Group, ok: Item[], failed: Item[]) {
  const db = useDb()
  const at = now()
  db.transaction((tx) => {
    if (ok.length) {
      const snap = tx.select().from(schema.snapshots).where(and(eq(schema.snapshots.provider, provider), eq(schema.snapshots.collectionId, g.collectionId))).get()
      let items: SnapshotItem[] = snap?.items ?? []
      const removed = new Set(ok.filter(i => i.change === 'remove').map(i => i.canonicalTrackId))
      items = items.filter(s => !removed.has(s.canonicalTrackId))
      const have = new Set(items.map(s => s.canonicalTrackId))
      for (const i of ok.filter(x => x.change === 'add' && !have.has(x.canonicalTrackId))) {
        items.push({ canonicalTrackId: i.canonicalTrackId, providerTrackId: i.trackId!, available: true })
      }
      if (snap) {
        tx.update(schema.snapshots).set({ items }).where(eq(schema.snapshots.id, snap.id)).run()
      } else {
        tx.insert(schema.snapshots).values({ provider, collectionId: g.collectionId, providerCollectionId: g.playlistId, takenAt: at, items }).run()
      }
      for (const i of ok) {
        tx.delete(schema.stagedChanges).where(and(eq(schema.stagedChanges.collectionId, g.collectionId), eq(schema.stagedChanges.canonicalTrackId, i.canonicalTrackId), eq(schema.stagedChanges.provider, provider))).run()
      }
    }
    for (const i of failed) {
      const key = and(eq(schema.stagedChanges.collectionId, g.collectionId), eq(schema.stagedChanges.canonicalTrackId, i.canonicalTrackId), eq(schema.stagedChanges.provider, provider))
      const row = tx.select().from(schema.stagedChanges).where(key).get()
      if (row) tx.update(schema.stagedChanges).set({ lastError: i.error, attempts: row.attempts + 1, lastAttemptAt: at }).where(key).run()
    }
  })
}

const firstError = (items: Item[]) => items.find(i => i.error)?.error ?? null
