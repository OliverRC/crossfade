// Playlist cleanup (docs/decisions/0004): merge exact duplicate copies of a Tidal playlist into one, and remove
// empty Tidal playlists. The only write path before M5. Each group is read fresh from Tidal before writing, and a
// copy is deleted only after the kept playlist has been read back and holds every item of every copy.
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { CleanupJobView, CleanupOutcome, CleanupView, DuplicateGroupView, EmptyPlaylistView, PlaylistRef, ProviderId, ProviderTrack } from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import { findDuplicates, mergePlan, missingFrom, type DuplicateTier, type PlaylistItems } from '../core/duplicates'
import { normaliseText } from '../core/normalise'
import { QuotaError, requestCounts } from '../providers/http'
import { createTidalPlaylistEditor, type PlaylistItemRef, type TidalPlaylistEditor } from '../providers/tidal'
import { getAccount } from '../utils/accounts'
import { schema, useDb } from '../utils/db'
import { acquire, release } from './lock'
import { mergeCollection, withRemembered } from './pull'
import { quotaBlockedUntil } from './quota'
import { createRunLog, type RunLog } from './run-log'

/** Services cleanup may write to. Spotify duplicates are shown only. */
const WRITABLE: ProviderId[] = ['tidal']

/** The latest cleanup, kept in memory; what it deleted is also in `playlist_backups`. */
let job: CleanupJobView | null = null

/** Same recording, same key: ISRC when known, else the service's own ID. */
export function itemKey(item: { type: string, id: string, isrc: string | null }): string {
  return item.isrc ? `isrc:${item.isrc}` : `${item.type}:${item.id}`
}
const trackKey = (t: ProviderTrack) => itemKey({ type: 'tracks', id: t.providerTrackId, isrc: t.isrc })

const playlistUrl = (provider: ProviderId, id: string) =>
  provider === 'tidal' ? `https://listen.tidal.com/playlist/${id}` : `https://open.spotify.com/playlist/${id}`

interface Fetched {
  runId: number
  fetchedAt: string
  playlists: PlaylistItems[]
}

/** Playlists from the latest pull (or V0 sync) that fetched every playlist of this service. */
function loadFetched(provider: ProviderId): Fetched | null {
  const db = useDb()
  const runs = db.select({ id: schema.syncRuns.id, kind: schema.syncRuns.kind, provider: schema.syncRuns.provider, playlists: schema.syncRuns.playlists }).from(schema.syncRuns)
    .orderBy(desc(schema.syncRuns.id)).all().filter(r => r.kind === 'sync' || (r.kind === 'pull' && r.provider === provider))
  for (const run of runs) {
    // Followed playlists are listed but never read, so they have no saved fetch.
    const listed = run.playlists?.[provider]?.filter(p => p.access !== 'followed')
    if (!listed) continue
    const saved = db.select().from(schema.fetchCheckpoints).where(eq(schema.fetchCheckpoints.runId, run.id)).all()
      .filter(c => c.provider === provider && c.kind === 'playlist')
    const byKey = new Map(saved.map(c => [c.collectionKey, c]))
    if (!listed.every(p => byKey.has(p.providerCollectionId))) continue
    return {
      runId: run.id,
      fetchedAt: saved.reduce((latest, c) => (c.fetchedAt > latest ? c.fetchedAt : latest), ''),
      playlists: listed.map(p => ({ id: p.providerCollectionId, name: p.name, items: byKey.get(p.providerCollectionId)!.tracks.map(trackKey) })),
    }
  }
  return null
}

const groupKey = (provider: ProviderId, copies: { id: string }[]) => `${provider}:${copies.map(c => c.id).sort().join('+')}`

export function cleanupView(): CleanupView {
  const groups: DuplicateGroupView[] = []
  const empty: EmptyPlaylistView[] = []
  const sources: CleanupView['sources'] = { spotify: null, tidal: null }
  const all = { spotify: loadFetched('spotify'), tidal: loadFetched('tidal') }
  /** The other service's playlists with this name, so each row shows what stays untouched there. */
  const counterpart = (provider: ProviderId, name: string): PlaylistRef[] => {
    const other: ProviderId = provider === 'tidal' ? 'spotify' : 'tidal'
    return (all[other]?.playlists ?? []).filter(p => normaliseText(p.name) === normaliseText(name))
      .map(p => ({ provider: other, id: p.id, name: p.name, url: playlistUrl(other, p.id), items: p.items.length }))
  }
  for (const provider of PROVIDERS) {
    const fetched = all[provider]
    if (!fetched) continue
    sources[provider] = { runId: fetched.runId, fetchedAt: fetched.fetchedAt }
    const report = findDuplicates(fetched.playlists)
    const actionable = WRITABLE.includes(provider)
    for (const p of report.empty) empty.push({ key: `${provider}:${p.id}`, provider, id: p.id, name: p.name, url: playlistUrl(provider, p.id), actionable, counterpart: counterpart(provider, p.name) })
    for (const g of report.groups) {
      groups.push({
        key: groupKey(provider, g.copies),
        provider,
        tier: g.tier,
        name: g.name,
        shared: g.shared,
        union: g.union,
        actionable,
        counterpart: counterpart(provider, g.name),
        copies: g.copies.map((c) => {
          const others = new Set(g.copies.filter(o => o !== c).flatMap(o => o.items))
          return {
            id: c.id,
            name: c.name,
            url: playlistUrl(provider, c.id),
            items: c.items.length,
            unique: new Set(c.items.filter(i => !others.has(i))).size,
            afterIfKept: c.items.length + mergePlan(g.copies, c.id).add.length,
          }
        }),
      })
    }
  }
  const db = useDb()
  const backups = db.select({ id: schema.playlistBackups.id }).from(schema.playlistBackups).all().length
  const remembered = db.select().from(schema.unavailableItems).all().filter(u => !u.restoredAt)
  // Pulled songs have no details on Tidal any more; the canonical library may know them from the other service.
  const isrcs = remembered.map(u => u.isrc).filter((i): i is string => Boolean(i))
  const known = new Map((isrcs.length ? db.select().from(schema.canonicalTracks).where(inArray(schema.canonicalTracks.isrc, isrcs)).all() : []).map(t => [t.isrc!, t]))
  const pulled = remembered.map(u => ({
    provider: u.provider, isrc: u.isrc, title: (u.isrc && known.get(u.isrc)?.title) || null, artists: (u.isrc && known.get(u.isrc)?.artists) || [],
    playlistName: u.playlistName, playlistUrl: playlistUrl(u.provider, u.playlistId), foundAt: u.foundAt,
  }))
  return { sources, groups, empty, job, backups, pulled }
}

export interface CleanupSelection {
  /** Exact-copy groups to merge, by group key, with the copy to keep. */
  merges: { key: string, keeperId: string }[]
  /** Empty playlists to remove, by key. */
  empties: string[]
}

/** Start a cleanup in the background. Throws when the selection is invalid or another job holds the lock. */
export function startCleanup(selection: CleanupSelection, editor?: TidalPlaylistEditor): CleanupJobView {
  const account = getAccount('tidal')
  if (!account || account.needsReconnect) throw new Error('Connect Tidal first')
  const tidal = editor ?? createTidalPlaylistEditor(account.country ?? 'US')
  if (!account.scopes.split(' ').includes('playlists.write')) throw new Error('Reconnect Tidal to grant playlist write access')
  const blocked = quotaBlockedUntil('tidal')
  if (blocked) throw new Error(`Tidal is rate limited until ${blocked}`)

  const fetched = loadFetched('tidal')
  if (!fetched) throw new Error('Pull Tidal first so Crossfade has your Tidal playlists')
  const report = findDuplicates(fetched.playlists)
  const tasks: Task[] = []
  for (const m of selection.merges) {
    const group = report.groups.find(g => groupKey('tidal', g.copies) === m.key)
    if (!group) throw new Error(`Unknown duplicate group ${m.key}`)
    if (!group.copies.some(c => c.id === m.keeperId)) throw new Error(`The playlist to keep is not one of the "${group.name}" copies`)
    tasks.push({ kind: 'merge', key: m.key, name: group.name, ids: group.copies.map(c => c.id), keeperId: m.keeperId, tier: group.tier })
  }
  for (const key of selection.empties) {
    const p = report.empty.find(e => `tidal:${e.id}` === key)
    if (!p) throw new Error(`Unknown empty playlist ${key}`)
    tasks.push({ kind: 'empty', key, name: p.name, ids: [p.id] })
  }
  if (!tasks.length) throw new Error('Nothing selected')
  if (!acquire('cleanup')) throw new Error('A sync or cleanup is running; try again when it finishes')

  // Every cleanup is an Activity entry: it writes to Tidal.
  const activity = useDb().insert(schema.syncRuns).values({
    kind: 'cleanup', provider: 'tidal', trigger: 'manual', startedAt: new Date().toISOString(), status: 'running', attempts: 1, stages: {},
  }).returning({ id: schema.syncRuns.id }).get()
  job = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    outcomes: tasks.map((t): CleanupOutcome => ({ key: t.key, kind: t.kind, name: t.name, status: 'queued', detail: null, added: 0, deleted: 0, pulled: 0 })),
  }
  run(tasks, job, tidal, createRunLog(activity.id), activity.id).finally(() => release('cleanup'))
  return job
}

type Task =
  /** tier: how alike the copies were when Oliver chose to merge them. */
  | { kind: 'merge', key: string, name: string, ids: string[], keeperId: string, tier: DuplicateTier }
  | { kind: 'empty', key: string, name: string, ids: string[] }

class Skip extends Error {}

const TIER_RANK: Record<DuplicateTier, number> = { exact: 0, contained: 1, different: 2 }
const TIER_TEXT: Record<DuplicateTier, string> = { exact: 'copies', contained: 'one inside the other', different: 'different tracks' }

async function run(tasks: Task[], state: CleanupJobView, tidal: TidalPlaylistEditor, log: RunLog, activityId: number) {
  const startRequests = requestCounts.tidal
  log.stage('cleanup', { status: 'running', done: 0, total: tasks.length, detail: null })
  log.event('info', 'cleanup', `Started by you: ${tasks.filter(t => t.kind === 'merge').length} merges and ${tasks.filter(t => t.kind === 'empty').length} empty playlists on Tidal`)
  for (const [i, task] of tasks.entries()) {
    const outcome = state.outcomes[i]!
    outcome.status = 'running'
    log.stage('cleanup', { detail: `"${task.name}"` })
    try {
      if (task.kind === 'merge') await merge(tidal, task, outcome)
      else await removeEmpty(tidal, task, outcome)
      outcome.status = 'done'
      log.event('info', 'cleanup', task.kind === 'merge'
        ? `Merged "${task.name}": ${outcome.detail}; deleted ${outcome.deleted === 1 ? 'the other copy' : `${outcome.deleted} copies`} from Tidal, saved first`
        : `Deleted the empty playlist "${task.name}" from Tidal, saved first`)
    } catch (error) {
      if (error instanceof Skip) {
        outcome.status = 'skipped'
        outcome.detail = error.message
        log.event('info', 'cleanup', `Skipped "${task.name}": ${error.message}`)
        continue
      }
      outcome.status = 'failed'
      outcome.detail = (error as Error).message
      log.event('error', 'cleanup', `Failed "${task.name}": ${outcome.detail}`)
      if (error instanceof QuotaError) {
        // Tidal asked for a long wait: stop rather than hammer it. Nothing half-done is deleted.
        for (const rest of state.outcomes.slice(i + 1)) { rest.status = 'not_attempted'; rest.detail = 'Stopped: Tidal is rate limiting' }
        state.error = error.message
        break
      }
    } finally {
      log.stage('cleanup', { done: i + 1 })
    }
  }
  state.running = false
  state.finishedAt = new Date().toISOString()

  const tally = (status: CleanupOutcome['status']) => state.outcomes.filter(o => o.status === status).length
  const counts = {
    merged: state.outcomes.filter(o => o.kind === 'merge' && o.status === 'done').length,
    deleted: state.outcomes.reduce((n, o) => n + o.deleted, 0),
    added: state.outcomes.reduce((n, o) => n + o.added, 0),
    pulled: state.outcomes.reduce((n, o) => n + o.pulled, 0),
    skipped: tally('skipped'),
    failed: tally('failed'),
    tidalRequests: requestCounts.tidal - startRequests,
  }
  log.stage('cleanup', { status: state.error ? 'failed' : 'done', detail: `${counts.deleted} deleted from Tidal, ${counts.added} songs added, ${counts.skipped} skipped, ${counts.failed} failed` })
  log.flush()
  useDb().update(schema.syncRuns).set({ status: state.error ? 'failed' : 'succeeded', finishedAt: state.finishedAt, error: state.error, counts })
    .where(eq(schema.syncRuns.id, activityId)).run()
}

interface FreshCopy extends PlaylistItems {
  info: { description: string | null, accessType: string | null }
  refs: PlaylistItemRef[]
}

/** Read a playlist as Tidal stores it now. A count mismatch means items are hidden from us, so nothing is touched. */
async function readFresh(tidal: TidalPlaylistEditor, id: string): Promise<FreshCopy> {
  const info = await tidal.getPlaylist(id)
  if (!info) throw new Skip('No longer exists on Tidal; nothing was changed')
  const refs = await tidal.getItems(id)
  if (refs.length !== info.numberOfItems) {
    throw new Error(`Tidal reports ${info.numberOfItems} items in "${info.name}" but returned ${refs.length}; nothing was changed`)
  }
  return { id, name: info.name, items: refs.map(itemKey), refs, info: { description: info.description, accessType: info.accessType } }
}

async function merge(tidal: TidalPlaylistEditor, task: Extract<Task, { kind: 'merge' }>, outcome: CleanupOutcome) {
  const copies: FreshCopy[] = []
  for (const id of task.ids) copies.push(await readFresh(tidal, id))

  // Re-check against what Tidal holds now, not the sync's snapshot.
  if (new Set(copies.map(c => normaliseText(c.name))).size > 1) throw new Skip('A copy was renamed since the last sync')
  // Merging never loses a song, but copies that drifted further apart than Oliver saw are his call again.
  const tier = findDuplicates(copies).groups[0]?.tier
  if (!tier || TIER_RANK[tier] > TIER_RANK[task.tier]) {
    throw new Skip(`Changed on Tidal since the last pull (was ${TIER_TEXT[task.tier]}, now ${tier ? TIER_TEXT[tier] : 'not a duplicate'}); nothing was changed`)
  }

  const plan = mergePlan(copies, task.keeperId)
  const refByKey = new Map<string, PlaylistItemRef>()
  const foundIn = new Map<string, string>()
  for (const c of copies) {
    for (const r of c.refs) {
      if (refByKey.has(itemKey(r))) continue
      refByKey.set(itemKey(r), r)
      foundIn.set(itemKey(r), c.id)
    }
  }

  // Tidal cannot add a song it no longer offers. A pulled song that is back under a new ID is added as that;
  // the rest are remembered instead of carried over.
  const wanted = plan.add.map(k => refByKey.get(k)!)
  const playable = wanted.length ? await tidal.playable(wanted) : new Set<string>()
  let pulled = wanted.filter(r => !playable.has(`${r.type}:${r.id}`))
  const returned = await tidal.findPlayableByIsrcs(pulled.map(r => r.isrc).filter((i): i is string => Boolean(i)))
  const toAdd = [...wanted.filter(r => playable.has(`${r.type}:${r.id}`)), ...pulled.flatMap(r => (r.isrc && returned.has(r.isrc) ? [returned.get(r.isrc)!] : []))]
  pulled = pulled.filter(r => !(r.isrc && returned.has(r.isrc)))
  if (toAdd.length) await tidal.addItems(plan.keeper.id, toAdd)
  outcome.added = toAdd.length

  // The guarantee: read the kept playlist back and require every playable song of every copy before deleting anything.
  const after = await tidal.getItems(plan.keeper.id)
  const pulledKeys = new Set(pulled.map(itemKey))
  const missing = missingFrom(after.map(itemKey), plan.union).filter(k => !pulledKeys.has(k))
  if (missing.length) {
    throw new Error(`${missing.length} of ${plan.union.length} songs did not reach the kept playlist (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}); no copy was deleted`)
  }

  rememberPulled(pulled, plan.keeper, foundIn)
  for (const spare of plan.spares as FreshCopy[]) {
    await deleteWithBackup(tidal, spare, 'merged', plan.keeper.id)
    outcome.deleted = (outcome.deleted ?? 0) + 1
  }
  forgetPlaylists('tidal', plan.spares.map(s => s.id), plan.keeper.id)
  outcome.pulled = pulled.length
  outcome.detail = [
    `Kept ${after.length} songs`,
    toAdd.length ? `added ${toAdd.length}` : 'nothing to add',
    ...(pulled.length ? [`${pulled.length} pulled from Tidal, remembered`] : []),
  ].join('; ')
}

function rememberPulled(pulled: PlaylistItemRef[], keeper: PlaylistItems, foundIn: Map<string, string>) {
  const now = new Date().toISOString()
  for (const r of pulled) {
    useDb().insert(schema.unavailableItems).values({
      provider: 'tidal', itemType: r.type, itemId: r.id, isrc: r.isrc, playlistId: keeper.id, playlistName: keeper.name,
      foundInPlaylistId: foundIn.get(itemKey(r)) ?? '', foundAt: now,
    }).onConflictDoNothing().run()
  }
}

async function removeEmpty(tidal: TidalPlaylistEditor, task: Extract<Task, { kind: 'empty' }>, outcome: CleanupOutcome) {
  const copy = await readFresh(tidal, task.ids[0]!)
  if (copy.refs.length) throw new Skip(`No longer empty (${copy.refs.length} items); nothing was changed`)
  await deleteWithBackup(tidal, copy, 'empty', null)
  outcome.deleted = 1
  forgetPlaylists('tidal', [copy.id], null)
}

async function deleteWithBackup(tidal: TidalPlaylistEditor, copy: FreshCopy, reason: 'empty' | 'merged', keptPlaylistId: string | null) {
  const db = useDb()
  const backup = db.insert(schema.playlistBackups).values({
    provider: 'tidal', playlistId: copy.id, name: copy.name, description: copy.info.description, accessType: copy.info.accessType,
    items: copy.refs, reason, keptPlaylistId, savedAt: new Date().toISOString(),
  }).returning({ id: schema.playlistBackups.id }).get()
  await tidal.deletePlaylist(copy.id)
  db.update(schema.playlistBackups).set({ deletedAt: new Date().toISOString() }).where(eq(schema.playlistBackups.id, backup.id)).run()
}

/**
 * Bring local state in line with what was just written, so the next sync and this page see it without refetching:
 * the kept playlist's saved fetch gains the spares' tracks, the deleted playlists leave every run's saved fetch,
 * and the kept playlist takes over a deleted copy's pairing with the other service.
 */
function forgetPlaylists(provider: ProviderId, deletedIds: string[], keeperId: string | null) {
  const db = useDb()
  db.transaction((tx) => {
    const checkpoints = tx.select().from(schema.fetchCheckpoints)
      .where(inArray(schema.fetchCheckpoints.collectionKey, keeperId ? [...deletedIds, keeperId] : deletedIds)).all()
      .filter(c => c.provider === provider)
    if (keeperId) {
      for (const kept of checkpoints.filter(c => c.collectionKey === keeperId)) {
        const tracks = [...kept.tracks]
        const have = new Set(tracks.map(trackKey))
        for (const spare of checkpoints.filter(c => c.runId === kept.runId && c.collectionKey !== keeperId)) {
          for (const t of spare.tracks) if (!have.has(trackKey(t))) { have.add(trackKey(t)); tracks.push(t) }
        }
        tx.update(schema.fetchCheckpoints).set({ tracks }).where(eq(schema.fetchCheckpoints.id, kept.id)).run()
      }
    }
    const gone = checkpoints.filter(c => deletedIds.includes(c.collectionKey)).map(c => c.id)
    if (gone.length) tx.delete(schema.fetchCheckpoints).where(inArray(schema.fetchCheckpoints.id, gone)).run()

    for (const run of tx.select({ id: schema.syncRuns.id, playlists: schema.syncRuns.playlists }).from(schema.syncRuns).all()) {
      const listed = run.playlists?.[provider]
      if (!listed?.some(p => deletedIds.includes(p.providerCollectionId))) continue
      const playlists = { ...run.playlists, [provider]: listed.filter(p => !deletedIds.includes(p.providerCollectionId)) }
      tx.update(schema.syncRuns).set({ playlists }).where(eq(schema.syncRuns.id, run.id)).run()
    }

    const links = tx.select().from(schema.collectionLinks).all()
    const deletedLinks = links.filter(l => l.provider === provider && l.providerCollectionId && deletedIds.includes(l.providerCollectionId))
    const keeperLink = keeperId ? links.find(l => l.provider === provider && l.providerCollectionId === keeperId) : undefined
    const paired = (collectionId: number) => links.some(l => l.collectionId === collectionId && l.provider !== provider)
    if (keeperLink && !paired(keeperLink.collectionId)) {
      const takeover = deletedLinks.find(l => paired(l.collectionId))
      if (takeover) tx.update(schema.collectionLinks).set({ collectionId: takeover.collectionId }).where(eq(schema.collectionLinks.id, keeperLink.id)).run()
    }
    if (deletedLinks.length) tx.delete(schema.collectionLinks).where(inArray(schema.collectionLinks.id, deletedLinks.map(l => l.id))).run()

    // Collections left with no service at all.
    const touched = [...new Set([...deletedLinks.map(l => l.collectionId), ...(keeperLink ? [keeperLink.collectionId] : [])])]
    const stillLinked = new Set(tx.select({ id: schema.collectionLinks.collectionId }).from(schema.collectionLinks).all().map(l => l.id))
    const orphans = touched.filter(id => !stillLinked.has(id))
    if (orphans.length) tx.delete(schema.collections).where(inArray(schema.collections.id, orphans)).run()
  })
  if (keeperId) recordKept(provider, keeperId)
}

/**
 * Main learns what the kept playlist holds now, as a pull would: the copies' songs merge into its collection and the
 * service's snapshot moves to the merged playlist. Without this, main would think the service holds none of them,
 * and a push would add them all again. Nothing to do before the service's first pull.
 */
function recordKept(provider: ProviderId, keeperId: string) {
  const db = useDb()
  if (!db.select({ id: schema.snapshots.id }).from(schema.snapshots).where(eq(schema.snapshots.provider, provider)).get()) return
  const link = db.select().from(schema.collectionLinks)
    .where(and(eq(schema.collectionLinks.provider, provider), eq(schema.collectionLinks.providerCollectionId, keeperId))).get()
  const kept = db.select().from(schema.fetchCheckpoints).where(eq(schema.fetchCheckpoints.collectionKey, keeperId)).all()
    .filter(c => c.provider === provider).sort((a, b) => b.runId - a.runId)[0]
  if (!link || !kept) return
  const canonical = new Map(db.select().from(schema.trackLinks).where(eq(schema.trackLinks.provider, provider)).all()
    .filter(l => l.providerTrackId).map(l => [l.providerTrackId!, l.canonicalTrackId]))
  const items = kept.tracks.flatMap(t => canonical.has(t.providerTrackId)
    ? [{ canonicalTrackId: canonical.get(t.providerTrackId)!, providerTrackId: t.providerTrackId, available: t.available !== false }]
    : [])
  mergeCollection({ provider, collectionId: link.collectionId, providerCollectionId: keeperId, items: withRemembered(provider, keeperId, items), runId: kept.runId, acceptRemovals: true })
}
