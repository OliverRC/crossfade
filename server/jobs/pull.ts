// Pull one service into main (docs/decisions/0005), in checkpointed stages: fetch its liked songs and owned
// playlists, link every track to a canonical record, pair playlists with main's collections, then merge each
// collection's changes since the service's last snapshot into main. Reads from the service only; never writes to it.
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { HoldReason, ProviderId, ProviderPlaylist, ProviderTrack, RunPause, SnapshotItem, StageKey } from '../../shared/types'
import { metadataMerges } from '../core/match'
import { normaliseText } from '../core/normalise'
import { pull, type MainEntry } from '../core/pull'
import { getProvider } from '../providers'
import { ProviderError, QuotaError, requestCounts } from '../providers/http'
import type { MusicProvider } from '../providers/types'
import { schema, useDb } from '../utils/db'
import { quotaBlockedUntil, quotaPause, providerNames } from './quota'
import { createRunLog, type RunLog } from './run-log'

type Report = (phase: string, message: string, done?: number, total?: number) => void

export interface FetchedCollection { provider: ProviderId, kind: 'liked' | 'playlist', providerCollectionId: string | null, name: string, tracks: ProviderTrack[] }

export interface PullCounts {
  collections: number
  added: number
  removed: number
  confirmed: number
  conflicts: number
  held: number
  requests: number
}

export interface PullOutcome {
  pause: RunPause | null
  counts: PullCounts
}

const now = () => new Date().toISOString()
const at = (iso: string) => `${iso.slice(11, 16)} UTC${iso.slice(0, 10) === now().slice(0, 10) ? '' : ` on ${iso.slice(0, 10)}`}`
const count = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`

export async function runPull(
  runId: number,
  provider: ProviderId,
  report: Report,
  service: MusicProvider = getProvider(provider),
  log: RunLog = createRunLog(runId),
): Promise<PullOutcome> {
  const db = useDb()
  const name = providerNames[provider]
  const startRequests = requestCounts[provider]
  const counts: PullCounts = { collections: 0, added: 0, removed: 0, confirmed: 0, conflicts: 0, held: 0, requests: 0 }
  const finish = (pause: RunPause | null): PullOutcome => {
    counts.requests = requestCounts[provider] - startRequests
    return { pause, counts }
  }

  // 1. List playlists and fetch every collection, checkpointing each one.
  const fetchKey: StageKey = `fetch:${provider}`
  const blocked = quotaBlockedUntil(provider)
  if (blocked) {
    log.stage(fetchKey, { status: 'paused', detail: `${name} quota cooling down until ${at(blocked)}` })
    log.event('warn', fetchKey, `Skipped: ${name} is rate limited until ${at(blocked)}`)
    return finish(quotaPause(provider))
  }
  const run = db.select({ playlists: schema.syncRuns.playlists }).from(schema.syncRuns).where(eq(schema.syncRuns.id, runId)).get()
  const playlists = { ...run?.playlists }
  const saved = () => db.select().from(schema.fetchCheckpoints).where(eq(schema.fetchCheckpoints.runId, runId)).all().filter(c => c.provider === provider)
  const done = new Set(saved().map(c => c.collectionKey))
  const tracksSoFar = () => saved().reduce((n, c) => n + c.tracks.length, 0)

  log.stage(fetchKey, { status: 'running', detail: playlists[provider] ? null : 'Listing playlists' })
  try {
    if (!playlists[provider]) {
      report('fetch', `Listing ${name} playlists`)
      playlists[provider] = await service.getPlaylists()
      db.update(schema.syncRuns).set({ playlists }).where(eq(schema.syncRuns.id, runId)).run()
      const listed = playlists[provider]!
      const shared = listed.filter(pl => pl.access === 'collaborative').length
      const followed = listed.filter(pl => pl.access === 'followed').length
      log.event('info', fetchKey, `Found ${count(listed.length - shared - followed, 'playlist')} you own on ${name}`
        + (shared ? `, ${shared} you collaborate on` : '')
        + (followed ? `, and ${followed} you only follow (${name} does not let apps read those, so they are listed but not read)` : ''))
    }
    const readable = playlists[provider]!.filter(pl => pl.access !== 'followed')
    const todo = [
      { kind: 'liked' as const, key: 'liked', name: 'Liked songs', access: 'owned' as const },
      ...readable.map(pl => ({ kind: 'playlist' as const, key: pl.providerCollectionId, name: pl.name, access: pl.access ?? 'owned' })),
    ]
    const fromCheckpoints = todo.filter(c => done.has(c.key)).length
    if (fromCheckpoints) log.event('info', fetchKey, `${count(fromCheckpoints, 'collection')} already fetched by an earlier attempt; skipping ${fromCheckpoints === 1 ? 'it' : 'them'}`)
    let fetchedNow = fromCheckpoints
    log.stage(fetchKey, { done: fetchedNow, total: todo.length, detail: `${count(tracksSoFar(), 'track')} so far` })
    for (const [i, c] of todo.entries()) {
      if (done.has(c.key)) continue
      const label = c.kind === 'liked' ? 'liked songs' : `"${c.name}"`
      report('fetch', `Reading ${name} ${label}`, i + 1, todo.length)
      log.stage(fetchKey, { detail: `Reading ${label}` })
      let tracks: ProviderTrack[]
      try {
        tracks = c.kind === 'liked' ? await service.getLikedTracks() : await service.getPlaylistTracks(c.key)
      } catch (error) {
        if (!(c.access === 'collaborative' && error instanceof ProviderError && error.status === 403)) throw error
        // Listed as collaborative, but the service will not show us its songs: treat it as followed.
        playlists[provider] = playlists[provider]!.map(pl => (pl.providerCollectionId === c.key ? { ...pl, access: 'followed' as const } : pl))
        db.update(schema.syncRuns).set({ playlists }).where(eq(schema.syncRuns.id, runId)).run()
        log.event('warn', fetchKey, `"${c.name}" is collaborative, but ${name} refused to return its songs; listed as followed instead`)
        log.stage(fetchKey, { done: ++fetchedNow })
        continue
      }
      db.insert(schema.fetchCheckpoints).values({ runId, provider, kind: c.kind, collectionKey: c.key, name: c.name, tracks, fetchedAt: now() }).run()
      done.add(c.key)
      log.stage(fetchKey, { done: ++fetchedNow })
      const unavailable = tracks.filter(t => t.available === false).length
      log.event('info', fetchKey, `Fetched ${label}: ${count(tracks.length, 'track')}${unavailable ? `, ${unavailable} unavailable on ${name}` : ''}`)
    }
    log.stage(fetchKey, { status: 'done', detail: `${count(tracksSoFar(), 'track')} in ${count(todo.length, 'collection')}` })
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error
    const pause = quotaPause(provider, error)
    log.stage(fetchKey, { status: 'paused', detail: `Rate limited; resumes at ${at(pause.resumeAt)}` })
    log.event('warn', fetchKey, `${error.message}. Everything fetched so far is saved; this resumes at ${at(pause.resumeAt)}`)
    return finish(pause)
  }

  const fetched: FetchedCollection[] = saved().map(c => ({
    provider, kind: c.kind, providerCollectionId: c.kind === 'liked' ? null : c.collectionKey, name: c.name, tracks: c.tracks,
  }))

  // 2. Link: every track maps to one canonical record; equal ISRCs share one, then equal metadata across services
  // (docs/decisions/0008). Idempotent.
  log.stage('link', { status: 'running', detail: null })
  report('link', 'Linking tracks by ISRC, then by metadata')
  const canonicalOf = linkTracks(fetched)
  const joined = mergeByMetadata()
  for (const [id, keep] of joined.into) for (const [trackId, canonicalId] of canonicalOf.ids) if (canonicalId === id) canonicalOf.ids.set(trackId, keep)
  if (joined.songs) log.event('info', 'link', `Joined ${count(joined.songs, 'song')} to the same song on the other service by title, artists, version and length (their ISRCs differ)`)
  log.stage('link', { status: 'done', detail: `${count(canonicalOf.created, 'new canonical record')}, ${count(canonicalOf.merged, 'linked')} to an existing one by ISRC${joined.songs ? `, ${joined.songs} by metadata` : ''}` })

  // 3. Pair collections: liked with liked, playlists by stored link or normalised name. Idempotent.
  log.stage('pair', { status: 'running', detail: null })
  report('pair', 'Pairing playlists')
  const listed = playlists[provider]!
  const collectionFor = pairCollections(fetched, listed)
  const followedCount = listed.filter(pl => pl.access === 'followed').length
  log.stage('pair', { status: 'done', detail: `${count(fetched.length, 'collection')}${followedCount ? `, ${followedCount} followed listed` : ''}` })

  // 4. Merge each collection into main, and flag playlists that are no longer on the service.
  log.stage('merge', { status: 'running', done: 0, total: fetched.length, detail: null })
  report('merge', `Merging ${name} into main`)
  for (const [i, col] of fetched.entries()) {
    const collectionId = collectionFor.get(col)!
    const items = withRemembered(provider, col.providerCollectionId, col.tracks.map(t => ({ canonicalTrackId: canonicalOf.ids.get(t.providerTrackId)!, providerTrackId: t.providerTrackId, available: t.available !== false })))
    const merged = mergeCollection({ provider, collectionId, providerCollectionId: col.providerCollectionId, items, runId })
    counts.collections++
    counts.added += merged.added
    counts.removed += merged.removed
    counts.confirmed += merged.confirmed
    counts.conflicts += merged.conflicts
    if (merged.hold) {
      counts.held++
      log.event('warn', 'merge', `Held "${col.name}": ${holdText(merged.hold.reason, merged.hold.before, merged.hold.removing, name)}. Nothing in it was merged; accept on the Library page if this is right`)
    }
    log.stage('merge', { done: i + 1 })
  }
  counts.held += flagGonePlaylists(provider, listed, runId, log)
  log.stage('merge', {
    status: 'done',
    detail: `${counts.added} added, ${counts.removed} removed, ${count(counts.conflicts, 'conflict')}${counts.held ? `, ${counts.held} held` : ''}`,
  })
  log.flush()
  return finish(null)
}

/**
 * Songs cleanup could not carry into a kept playlist because the service no longer offers them (docs/decisions/0004)
 * still belong in it: they count as held by the service, unavailable, so a pull never reads them as removed.
 */
export function withRemembered(provider: ProviderId, providerCollectionId: string | null, items: SnapshotItem[]): SnapshotItem[] {
  if (!providerCollectionId) return items
  const db = useDb()
  const remembered = db.select().from(schema.unavailableItems)
    .where(and(eq(schema.unavailableItems.provider, provider), eq(schema.unavailableItems.playlistId, providerCollectionId), isNull(schema.unavailableItems.restoredAt))).all()
  if (!remembered.length) return items
  const have = new Set(items.map(i => i.canonicalTrackId))
  const byTrack = new Map(db.select().from(schema.trackLinks).where(eq(schema.trackLinks.provider, provider)).all()
    .filter(l => l.providerTrackId).map(l => [l.providerTrackId!, l.canonicalTrackId]))
  const byIsrc = new Map(db.select({ id: schema.canonicalTracks.id, isrc: schema.canonicalTracks.isrc }).from(schema.canonicalTracks).all()
    .filter(c => c.isrc).map(c => [c.isrc!, c.id]))
  const out = [...items]
  for (const r of remembered) {
    const canonicalTrackId = byTrack.get(r.itemId) ?? (r.isrc ? byIsrc.get(r.isrc) : undefined)
    if (canonicalTrackId === undefined || have.has(canonicalTrackId)) continue
    have.add(canonicalTrackId)
    out.push({ canonicalTrackId, providerTrackId: r.itemId, available: false })
  }
  return out
}

export function holdText(reason: HoldReason, before: number, removing: number, service: string): string {
  if (reason === 'empty') return `came back empty from ${service} after ${count(before, 'song')}`
  if (reason === 'gone') return `no longer on ${service}`
  return `would lose ${removing} of its ${count(before, 'song')} on ${service}`
}

interface MergeInput {
  provider: ProviderId
  collectionId: number
  providerCollectionId: string | null
  items: SnapshotItem[]
  runId: number
  /** Oliver accepted the removals the sanity guard held. */
  acceptRemovals?: boolean
}

interface MergeResult { added: number, removed: number, confirmed: number, conflicts: number, hold: { reason: HoldReason, before: number, removing: number } | null }

/** Merge one collection's read into main and move the service's snapshot forward, unless the sanity guard holds it. */
export function mergeCollection(input: MergeInput): MergeResult {
  const db = useDb()
  const { provider, collectionId } = input
  const result: MergeResult = { added: 0, removed: 0, confirmed: 0, conflicts: 0, hold: null }
  db.transaction((tx) => {
    const snapshot = tx.select().from(schema.snapshots).where(and(eq(schema.snapshots.provider, provider), eq(schema.snapshots.collectionId, collectionId))).get()
    const rows = tx.select().from(schema.memberships).where(eq(schema.memberships.collectionId, collectionId)).all()
    const main = new Map<number, MainEntry>(rows.map(m => [m.canonicalTrackId, { state: m.state, changedAt: m.changedAt, changedBy: m.changedBy }]))
    const openHolds = tx.select().from(schema.pullHolds)
      .where(and(eq(schema.pullHolds.provider, provider), eq(schema.pullHolds.collectionId, collectionId), isNull(schema.pullHolds.resolvedAt))).all()

    const outcome = pull({
      provider,
      now: new Set(input.items.map(i => i.canonicalTrackId)),
      base: snapshot ? { items: new Set(snapshot.items.map(i => i.canonicalTrackId)), takenAt: snapshot.takenAt } : null,
      main,
      acceptRemovals: input.acceptRemovals,
    })
    const at = now()

    if (outcome.hold) {
      result.hold = outcome.hold
      const hold = { runId: input.runId, reason: outcome.hold.reason, before: outcome.hold.before, removing: outcome.hold.removing, detectedAt: at }
      if (openHolds[0]) tx.update(schema.pullHolds).set(hold).where(eq(schema.pullHolds.id, openHolds[0].id)).run()
      else tx.insert(schema.pullHolds).values({ provider, collectionId, ...hold }).run()
      return
    }
    for (const h of openHolds) {
      tx.update(schema.pullHolds).set({ resolvedAt: at, resolution: input.acceptRemovals ? 'accepted' : 'superseded' }).where(eq(schema.pullHolds.id, h.id)).run()
    }

    const openConflicts = new Set(tx.select({ track: schema.conflicts.canonicalTrackId }).from(schema.conflicts)
      .where(and(eq(schema.conflicts.collectionId, collectionId), isNull(schema.conflicts.resolvedAt))).all().map(c => c.track))
    for (const c of outcome.changes) {
      if (c.kind === 'conflict') {
        if (openConflicts.has(c.canonicalTrackId)) continue
        tx.insert(schema.conflicts).values({ collectionId, canonicalTrackId: c.canonicalTrackId, provider, change: c.change, detectedAt: at }).run()
        result.conflicts++
        continue
      }
      const state = c.kind === 'remove' ? 'removed' as const : 'active' as const
      tx.insert(schema.memberships).values({ collectionId, canonicalTrackId: c.canonicalTrackId, state, changedAt: at, changedBy: provider })
        .onConflictDoUpdate({ target: [schema.memberships.collectionId, schema.memberships.canonicalTrackId], set: { state, changedAt: at, changedBy: provider } }).run()
      if (c.kind === 'add') result.added++
      if (c.kind === 'remove') result.removed++
      if (c.kind === 'confirm') result.confirmed++
    }

    const values = { provider, collectionId, providerCollectionId: input.providerCollectionId, takenAt: at, items: input.items, runId: input.runId }
    tx.insert(schema.snapshots).values(values)
      .onConflictDoUpdate({ target: [schema.snapshots.provider, schema.snapshots.collectionId], set: values }).run()
  })
  return result
}

/** A playlist the service had at its last pull but no longer lists: held, never treated as every song removed. */
function flagGonePlaylists(provider: ProviderId, playlists: ProviderPlaylist[], runId: number, log: RunLog): number {
  const db = useDb()
  const listed = new Set(playlists.map(pl => pl.providerCollectionId))
  const gone = db.select().from(schema.snapshots).where(eq(schema.snapshots.provider, provider)).all()
    .filter(s => s.providerCollectionId && !listed.has(s.providerCollectionId))
  for (const s of gone) {
    const open = db.select().from(schema.pullHolds)
      .where(and(eq(schema.pullHolds.provider, provider), eq(schema.pullHolds.collectionId, s.collectionId), isNull(schema.pullHolds.resolvedAt))).get()
    const hold = { runId, reason: 'gone' as const, before: s.items.length, removing: s.items.length, detectedAt: now() }
    if (open) db.update(schema.pullHolds).set(hold).where(eq(schema.pullHolds.id, open.id)).run()
    else db.insert(schema.pullHolds).values({ provider, collectionId: s.collectionId, ...hold }).run()
    const collection = db.select({ name: schema.collections.name }).from(schema.collections).where(eq(schema.collections.id, s.collectionId)).get()
    log.event('warn', 'merge', `"${collection?.name ?? 'A playlist'}" is no longer on ${providerNames[provider]}. Main still has it; decide on the Library page`)
  }
  return gone.length
}

/** Map every fetched track to a canonical record, creating records and links as needed. Idempotent. */
function linkTracks(fetched: FetchedCollection[]): { ids: Map<string, number>, created: number, merged: number } {
  const db = useDb()
  const provider = fetched[0]?.provider
  const ids = new Map<string, number>()
  let created = 0
  let merged = 0
  if (!provider) return { ids, created, merged }

  const links = db.select().from(schema.trackLinks).all()
  const linkByProviderTrack = new Map(links.filter(l => l.provider === provider && l.providerTrackId).map(l => [l.providerTrackId!, l]))
  const canonicalByIsrc = new Map(db.select({ id: schema.canonicalTracks.id, isrc: schema.canonicalTracks.isrc }).from(schema.canonicalTracks).all()
    .filter(c => c.isrc).map(c => [c.isrc!, c.id]))
  const preferred = new Set(links.filter(l => l.isPreferred).map(l => `${l.canonicalTrackId}:${l.provider}`))

  db.transaction((tx) => {
    for (const col of fetched) {
      for (const t of col.tracks) {
        if (ids.has(t.providerTrackId)) continue
        const copy = { isrc: t.isrc, title: t.title, album: t.album }
        const existing = linkByProviderTrack.get(t.providerTrackId)
        if (existing) {
          if (existing.isrc !== copy.isrc || existing.title !== copy.title || existing.album !== copy.album) {
            tx.update(schema.trackLinks).set(copy).where(eq(schema.trackLinks.id, existing.id)).run()
          }
          ids.set(t.providerTrackId, existing.canonicalTrackId)
          continue
        }

        let canonicalId = t.isrc ? canonicalByIsrc.get(t.isrc) : undefined
        const method = canonicalId ? 'isrc' : 'origin'
        if (!canonicalId) {
          canonicalId = tx.insert(schema.canonicalTracks).values({ isrc: t.isrc, title: t.title, version: t.version, artists: t.artists, album: t.album, durationMs: t.durationMs })
            .returning({ id: schema.canonicalTracks.id }).get().id
          if (t.isrc) canonicalByIsrc.set(t.isrc, canonicalId)
          created++
        } else {
          merged++
        }
        const hasPreferred = preferred.has(`${canonicalId}:${provider}`)
        preferred.add(`${canonicalId}:${provider}`)
        // The track is in the library now, so any earlier unmatched or review placeholder for this side is stale.
        const placeholders = links.filter(l => l.canonicalTrackId === canonicalId && l.provider === provider && !l.providerTrackId).map(l => l.id)
        for (const id of placeholders) tx.delete(schema.trackLinks).where(eq(schema.trackLinks.id, id)).run()

        const link = tx.insert(schema.trackLinks).values({
          canonicalTrackId: canonicalId, provider, providerTrackId: t.providerTrackId, ...copy, status: 'matched',
          method, confidence: 1, isPreferred: !hasPreferred, lastCheckedAt: now(),
        }).returning().get()
        linkByProviderTrack.set(t.providerTrackId, link)
        ids.set(t.providerTrackId, canonicalId)
      }
    }
  })
  return { ids, created, merged }
}

/**
 * Fold songs that are one song by metadata into one canonical record (docs/decisions/0008): links, memberships,
 * snapshots, staged changes and conflicts move to the song that stays. Idempotent: once folded, nothing matches again.
 */
export function mergeByMetadata(): { songs: number, into: Map<number, number> } {
  const db = useDb()
  const providersOf = new Map<number, Set<ProviderId>>()
  for (const l of db.select().from(schema.trackLinks).all()) {
    if (l.providerTrackId) providersOf.set(l.canonicalTrackId, (providersOf.get(l.canonicalTrackId) ?? new Set()).add(l.provider))
  }
  const merges = metadataMerges(db.select().from(schema.canonicalTracks).all().map(c => ({
    id: c.id, title: c.title, version: c.version, artists: c.artists, durationMs: c.durationMs, providers: [...providersOf.get(c.id) ?? []],
  })))
  const into = new Map<number, number>()
  if (!merges.length) return { songs: 0, into }

  db.transaction((tx) => {
    for (const { keep, merge } of merges) {
      for (const gone of merge) into.set(gone, keep)
      const links = tx.select().from(schema.trackLinks).where(inArray(schema.trackLinks.canonicalTrackId, [keep, ...merge])).all()
      const kept = links.filter(l => l.canonicalTrackId === keep)
      for (const l of links.filter(l => l.canonicalTrackId !== keep)) {
        const real = (p: ProviderId) => kept.some(k => k.provider === p && k.providerTrackId)
        // An unmatched or review placeholder is stale once the song has a real copy on that service.
        if (!l.providerTrackId && real(l.provider)) { tx.delete(schema.trackLinks).where(eq(schema.trackLinks.id, l.id)).run(); continue }
        const preferred = l.isPreferred && !kept.some(k => k.provider === l.provider && k.isPreferred)
        tx.update(schema.trackLinks).set({ canonicalTrackId: keep, method: l.providerTrackId ? 'metadata' : l.method, isPreferred: preferred })
          .where(eq(schema.trackLinks.id, l.id)).run()
        kept.push({ ...l, canonicalTrackId: keep, isPreferred: preferred })
      }
      for (const l of kept.filter(k => !k.providerTrackId && kept.some(o => o.provider === k.provider && o.providerTrackId))) {
        tx.delete(schema.trackLinks).where(eq(schema.trackLinks.id, l.id)).run()
      }

      // Memberships: where both songs are in a collection, the newer change wins, and an active one beats a removal.
      const rows = tx.select().from(schema.memberships).where(inArray(schema.memberships.canonicalTrackId, [keep, ...merge])).all()
      for (const collectionId of new Set(rows.map(r => r.collectionId))) {
        const here = rows.filter(r => r.collectionId === collectionId)
          .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.changedAt.localeCompare(a.changedAt))
        const [winner, ...losers] = here
        for (const r of losers) tx.delete(schema.memberships).where(eq(schema.memberships.id, r.id)).run()
        if (winner!.canonicalTrackId !== keep) tx.update(schema.memberships).set({ canonicalTrackId: keep }).where(eq(schema.memberships.id, winner!.id)).run()
      }

      // Staged picks and open conflicts: one per collection and service at most; a duplicate goes. Settled conflicts all move.
      for (const table of [schema.stagedChanges, schema.conflicts] as const) {
        const picks = tx.select().from(table).where(inArray(table.canonicalTrackId, [keep, ...merge])).all()
        const keyOf = (p: typeof picks[number]) => 'resolvedAt' in p && p.resolvedAt ? `settled:${p.id}` : `${p.collectionId}:${p.provider}`
        const seen = new Set(picks.filter(p => p.canonicalTrackId === keep).map(keyOf))
        for (const p of picks.filter(p => p.canonicalTrackId !== keep)) {
          const k = keyOf(p)
          if (seen.has(k)) tx.delete(table).where(eq(table.id, p.id)).run()
          else { seen.add(k); tx.update(table).set({ canonicalTrackId: keep }).where(eq(table.id, p.id)).run() }
        }
      }
      tx.delete(schema.canonicalTracks).where(inArray(schema.canonicalTracks.id, merge)).run()
    }

    // Snapshots: a service holding two releases of the song now holds it twice, under each release's ID.
    for (const snap of tx.select().from(schema.snapshots).all()) {
      if (!snap.items.some(i => into.has(i.canonicalTrackId))) continue
      const items = snap.items.map(i => ({ ...i, canonicalTrackId: into.get(i.canonicalTrackId) ?? i.canonicalTrackId }))
      tx.update(schema.snapshots).set({ items }).where(eq(schema.snapshots.id, snap.id)).run()
    }
  })
  return { songs: into.size, into }
}

/**
 * Pair each fetched collection with a collection in main: liked with liked, playlists by stored link or name.
 * Playlists the service lists but will not let us read (followed) are paired the same way, after the readable ones,
 * so main knows the service has them; they get no snapshot and are never pushed. Idempotent.
 */
function pairCollections(fetched: FetchedCollection[], listed: ProviderPlaylist[]): Map<FetchedCollection, number> {
  const db = useDb()
  const out = new Map<FetchedCollection, number>()
  const provider = fetched[0]?.provider
  if (!provider) return out
  const existing = db.select({ link: schema.collectionLinks, collection: schema.collections }).from(schema.collectionLinks)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.collectionLinks.collectionId)).all()
  const info = new Map(listed.map(pl => [pl.providerCollectionId, { access: pl.access ?? 'owned', ownerName: pl.ownerName ?? null }]))

  const likedId = existing.find(e => e.collection.kind === 'liked')?.collection.id
    ?? db.select({ id: schema.collections.id }).from(schema.collections).where(eq(schema.collections.kind, 'liked')).get()?.id
    ?? db.insert(schema.collections).values({ kind: 'liked', name: 'Liked songs' }).returning().get().id

  // Several collections can share a name (copies on one service); pair with the first this service is not on yet.
  const byName = new Map<string, { id: number, providers: Set<ProviderId> }[]>()
  const entries = new Map<number, { id: number, providers: Set<ProviderId> }>()
  for (const e of existing.filter(e => e.collection.kind === 'playlist')) {
    let entry = entries.get(e.collection.id)
    if (!entry) {
      entry = { id: e.collection.id, providers: new Set() }
      entries.set(e.collection.id, entry)
      const key = normaliseText(e.collection.name)
      byName.set(key, [...byName.get(key) ?? [], entry])
    }
    entry.providers.add(e.link.provider)
  }

  /** The collection a playlist belongs to, linking it on first sight and keeping its access current. */
  const pair = (providerCollectionId: string, name: string): number => {
    const { access, ownerName } = info.get(providerCollectionId) ?? { access: 'owned' as const, ownerName: null }
    const linked = existing.find(e => e.link.provider === provider && e.link.providerCollectionId === providerCollectionId)
    if (linked) {
      if (linked.link.access !== access || linked.link.ownerName !== ownerName) {
        db.update(schema.collectionLinks).set({ access, ownerName }).where(eq(schema.collectionLinks.id, linked.link.id)).run()
      }
      return linked.collection.id
    }
    const key = normaliseText(name)
    let entry = byName.get(key)?.find(e => !e.providers.has(provider))
    if (!entry) {
      entry = { id: db.insert(schema.collections).values({ kind: 'playlist', name }).returning().get().id, providers: new Set() }
      byName.set(key, [...byName.get(key) ?? [], entry])
    }
    db.insert(schema.collectionLinks).values({ collectionId: entry.id, provider, providerCollectionId, access, ownerName }).run()
    entry.providers.add(provider)
    return entry.id
  }

  for (const col of fetched) {
    if (col.kind === 'liked') {
      if (!existing.some(e => e.collection.kind === 'liked' && e.link.provider === col.provider)) {
        db.insert(schema.collectionLinks).values({ collectionId: likedId, provider: col.provider, providerCollectionId: null }).run()
      }
      out.set(col, likedId)
      continue
    }
    out.set(col, pair(col.providerCollectionId!, col.name))
  }

  const followed = listed.filter(pl => pl.access === 'followed')
  for (const pl of followed) {
    const collectionId = pair(pl.providerCollectionId, pl.name)
    // It can no longer be read (it stopped being collaborative), so its old snapshot means nothing now.
    db.delete(schema.snapshots).where(and(eq(schema.snapshots.provider, provider), eq(schema.snapshots.collectionId, collectionId))).run()
  }

  // Followed playlists the service no longer lists: drop the link, and the collection if nothing else holds it.
  const listedIds = new Set(listed.map(pl => pl.providerCollectionId))
  for (const e of existing) {
    if (e.link.provider !== provider || e.link.access !== 'followed' || listedIds.has(e.link.providerCollectionId!)) continue
    db.delete(schema.collectionLinks).where(eq(schema.collectionLinks.id, e.link.id)).run()
    const others = db.select({ id: schema.collectionLinks.id }).from(schema.collectionLinks).where(eq(schema.collectionLinks.collectionId, e.collection.id)).get()
    const songs = db.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.collectionId, e.collection.id)).get()
    if (!others && !songs) db.delete(schema.collections).where(eq(schema.collections.id, e.collection.id)).run()
  }
  return out
}
