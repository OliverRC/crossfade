// V0 dry-run sync, in checkpointed stages: list playlists, fetch collections, link tracks, pair
// playlists, match, diff. Playlist lists and fetched collections are saved against the run, and every
// match result is saved per track, so a paused or failed run resumes where it stopped.
// Reads from Spotify and Tidal only; nothing is written to either service.
import { eq } from 'drizzle-orm'
import { PROVIDERS, type CollectionDiff, type DiffRow, type ProviderId, type ProviderTrack, type RowState, type RunPause, type TrackView } from '../../shared/types'
import { diffCollection, type LinkInfo } from '../core/diff'
import { normaliseText, splitTitle } from '../core/normalise'
import { REVIEW_FLOOR, bestCandidate, pickIsrcResult } from '../core/score'
import { getProvider } from '../providers'
import { QuotaError, chunk, requestCounts } from '../providers/http'
import type { MusicProvider } from '../providers/types'
import { schema, useDb } from '../utils/db'
import { createRunLog, type RunLog } from './run-log'

type Report = (phase: string, message: string, done?: number, total?: number) => void
type LinkRow = typeof schema.trackLinks.$inferSelect

interface FetchedCollection { provider: ProviderId, kind: 'liked' | 'playlist', providerCollectionId: string | null, name: string, tracks: ProviderTrack[] }

export interface SyncOptions {
  /** Lookup requests (ISRC searches plus fuzzy searches) allowed per provider per run. */
  lookupBudget: Record<ProviderId, number>
  /**
   * Fall back to the target's free-text search when the ISRC lookup misses. Off in V0: it costs a request
   * per track, and Spotify's quota is the bottleneck. Comparing against the other library stays on (free).
   */
  fuzzySearch: boolean
}

export interface SyncOutcome {
  /** Empty when the run paused before every collection was fetched. */
  collections: CollectionDiff[]
  pause: RunPause | null
  requests: Record<ProviderId, number>
}

/** Spotify has no batch ISRC lookup and an unpublished quota, so its lookups are rationed per run. */
export function defaultOptions(): SyncOptions {
  return { lookupBudget: { spotify: Number(process.env.SPOTIFY_LOOKUPS_PER_RUN) || 150, tidal: Number.POSITIVE_INFINITY }, fuzzySearch: false }
}

const QUOTA_FALLBACK_MS = 6 * 3600_000 // no Retry-After: probe again in 6 hours (reported cooldowns run 13 to 18)
const BUDGET_PAUSE_MS = 30 * 60_000

const other = (p: ProviderId): ProviderId => (p === 'spotify' ? 'tidal' : 'spotify')
const view = (t: ProviderTrack): TrackView => ({ title: t.version ? `${t.title} (${t.version})` : t.title, artists: t.artists, durationMs: t.durationMs, isrc: t.isrc })
const now = () => new Date().toISOString()
const names: Record<ProviderId, string> = { spotify: 'Spotify', tidal: 'Tidal' }
const at = (iso: string) => `${iso.slice(11, 16)} UTC${iso.slice(0, 10) === now().slice(0, 10) ? '' : ` on ${iso.slice(0, 10)}`}`
const count = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`

export function quotaBlockedUntil(provider: ProviderId): string | null {
  const until = useDb().select({ until: schema.providerAccounts.quotaBlockedUntil }).from(schema.providerAccounts)
    .where(eq(schema.providerAccounts.provider, provider)).get()?.until
  return until && Date.parse(until) > Date.now() ? until : null
}

export async function runSync(
  runId: number,
  report: Report,
  providers: Record<ProviderId, MusicProvider> = Object.fromEntries(PROVIDERS.map(p => [p, getProvider(p)])) as Record<ProviderId, MusicProvider>,
  options: SyncOptions = defaultOptions(),
  log: RunLog = createRunLog(runId),
): Promise<SyncOutcome> {
  const db = useDb()
  const startRequests = { ...requestCounts }
  const requests = () => Object.fromEntries(PROVIDERS.map(p => [p, requestCounts[p] - startRequests[p]])) as Record<ProviderId, number>

  // The first pause wins; later ones only matter once it clears.
  const state: { pause: RunPause | null } = { pause: null }
  const pauseFor = (provider: ProviderId, reason: RunPause['reason'], error?: QuotaError): RunPause => {
    let resumeAt: string
    if (reason === 'quota') {
      const existing = quotaBlockedUntil(provider)
      resumeAt = existing ?? new Date(Date.now() + (error?.retryAfterSeconds ? error.retryAfterSeconds * 1000 : QUOTA_FALLBACK_MS)).toISOString()
      if (!existing) {
        db.update(schema.providerAccounts).set({
          quotaBlockedUntil: resumeAt,
          quotaHitAt: now(),
          quotaResetSource: error?.retryAfterSeconds ? 'retry-after' : 'estimate',
          quotaMessage: error?.message ?? null,
        }).where(eq(schema.providerAccounts.provider, provider)).run()
      }
    } else {
      resumeAt = new Date(Date.now() + BUDGET_PAUSE_MS).toISOString()
    }
    const message = reason === 'quota'
      ? `${names[provider]} quota used up${error?.retryAfterSeconds ? '' : ' (no reset time given)'}`
      : `${names[provider]} lookup budget for this run spent`
    const pause: RunPause = { provider, reason, resumeAt, message }
    state.pause ??= pause
    return pause
  }

  // 1. List playlists and fetch every collection, checkpointing each one.
  const run = db.select({ playlists: schema.syncRuns.playlists }).from(schema.syncRuns).where(eq(schema.syncRuns.id, runId)).get()
  const playlists = { ...run?.playlists }
  const saved = () => db.select().from(schema.fetchCheckpoints).where(eq(schema.fetchCheckpoints.runId, runId)).all()
  const done = new Set(saved().map(c => `${c.provider}:${c.collectionKey}`))

  for (const p of PROVIDERS) {
    const key = `fetch:${p}` as const
    const blocked = quotaBlockedUntil(p)
    if (blocked) {
      pauseFor(p, 'quota')
      log.stage(key, { status: 'paused', detail: `${names[p]} quota cooling down until ${at(blocked)}` })
      log.event('warn', key, `Skipped: ${names[p]} is rate limited until ${at(blocked)}`)
      continue
    }
    const tracksSoFar = () => saved().filter(c => c.provider === p).reduce((n, c) => n + c.tracks.length, 0)
    log.stage(key, { status: 'running', detail: playlists[p] ? null : 'Listing playlists' })
    try {
      if (!playlists[p]) {
        report('fetch', `Listing ${names[p]} playlists`)
        playlists[p] = await providers[p].getOwnedPlaylists()
        db.update(schema.syncRuns).set({ playlists }).where(eq(schema.syncRuns.id, runId)).run()
        log.event('info', key, `Found ${count(playlists[p]!.length, 'playlist')} you own on ${names[p]}`)
      }
      const todo = [{ kind: 'liked' as const, key: 'liked', name: 'Liked songs' }, ...playlists[p]!.map(pl => ({ kind: 'playlist' as const, key: pl.providerCollectionId, name: pl.name }))]
      const fromCheckpoints = todo.filter(c => done.has(`${p}:${c.key}`)).length
      if (fromCheckpoints) log.event('info', key, `${count(fromCheckpoints, 'collection')} already fetched by an earlier attempt; skipping ${fromCheckpoints === 1 ? 'it' : 'them'}`)
      let fetchedNow = fromCheckpoints
      log.stage(key, { done: fetchedNow, total: todo.length, detail: `${count(tracksSoFar(), 'track')} so far` })
      for (const [i, c] of todo.entries()) {
        if (done.has(`${p}:${c.key}`)) continue
        const label = c.kind === 'liked' ? 'liked songs' : `"${c.name}"`
        report('fetch', `Reading ${names[p]} ${label}`, i + 1, todo.length)
        log.stage(key, { detail: `Reading ${label}` })
        const tracks = c.kind === 'liked' ? await providers[p].getLikedTracks() : await providers[p].getPlaylistTracks(c.key)
        db.insert(schema.fetchCheckpoints).values({ runId, provider: p, kind: c.kind, collectionKey: c.key, name: c.name, tracks, fetchedAt: now() }).run()
        done.add(`${p}:${c.key}`)
        log.stage(key, { done: ++fetchedNow })
        log.event('info', key, `Fetched ${label}: ${count(tracks.length, 'track')}`)
      }
      log.stage(key, { status: 'done', detail: `${count(tracksSoFar(), 'track')} in ${count(todo.length, 'collection')}` })
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error
      const pause = pauseFor(p, 'quota', error) // keep going with the other provider; its checkpoints still count
      log.stage(key, { status: 'paused', detail: `Rate limited; resumes at ${at(pause.resumeAt)}` })
      log.event('warn', key, `${error.message}. Everything fetched so far is saved; this resumes at ${at(pause.resumeAt)}`)
    }
  }
  // Every stage after this needs both libraries complete.
  if (state.pause) {
    log.event('info', null, 'Later stages wait until both libraries are fully fetched')
    return { collections: [], pause: state.pause, requests: requests() }
  }

  const fetched: FetchedCollection[] = saved().map(c => ({
    provider: c.provider, kind: c.kind, providerCollectionId: c.kind === 'liked' ? null : c.collectionKey, name: c.name, tracks: c.tracks,
  }))

  // 2. Canonicalise: every provider track maps to one canonical track; equal ISRCs share one. Idempotent.
  log.stage('link', { status: 'running', detail: null })
  report('canonical', 'Linking tracks by ISRC')
  let created = 0
  let mergedByIsrc = 0
  const providerTracks = new Map<string, ProviderTrack>() // `${provider}:${id}`
  const canonicalOf = new Map<string, number>()
  const links = db.select().from(schema.trackLinks).all()
  const linkByProviderTrack = new Map(links.filter(l => l.providerTrackId).map(l => [`${l.provider}:${l.providerTrackId}`, l]))
  const canonicalByIsrc = new Map(db.select({ id: schema.canonicalTracks.id, isrc: schema.canonicalTracks.isrc }).from(schema.canonicalTracks).all()
    .filter(c => c.isrc).map(c => [c.isrc!, c.id]))
  const preferred = new Set(links.filter(l => l.isPreferred).map(l => `${l.canonicalTrackId}:${l.provider}`))

  db.transaction((tx) => {
    for (const col of fetched) {
      for (const t of col.tracks) {
        const key = `${col.provider}:${t.providerTrackId}`
        if (providerTracks.has(key)) continue
        providerTracks.set(key, t)

        const existing = linkByProviderTrack.get(key)
        if (existing) { canonicalOf.set(key, existing.canonicalTrackId); continue }

        let canonicalId = t.isrc ? canonicalByIsrc.get(t.isrc) : undefined
        const method = canonicalId ? 'isrc' : 'origin'
        if (!canonicalId) {
          canonicalId = tx.insert(schema.canonicalTracks).values({ isrc: t.isrc, title: t.title, artists: t.artists, album: t.album, durationMs: t.durationMs })
            .returning({ id: schema.canonicalTracks.id }).get().id
          if (t.isrc) canonicalByIsrc.set(t.isrc, canonicalId)
          created++
        } else {
          mergedByIsrc++
        }
        const hasPreferred = preferred.has(`${canonicalId}:${col.provider}`)
        preferred.add(`${canonicalId}:${col.provider}`)
        // The track is in the library now, so any earlier unmatched/review placeholder for this side is stale.
        const placeholderIds = links.filter(l => l.canonicalTrackId === canonicalId && l.provider === col.provider && !l.providerTrackId).map(l => l.id)
        for (const id of placeholderIds) tx.delete(schema.trackLinks).where(eq(schema.trackLinks.id, id)).run()

        const link = tx.insert(schema.trackLinks).values({
          canonicalTrackId: canonicalId, provider: col.provider, providerTrackId: t.providerTrackId, status: 'matched',
          method, confidence: 1, isPreferred: !hasPreferred, lastCheckedAt: now(),
        }).returning().get()
        linkByProviderTrack.set(key, link)
        canonicalOf.set(key, canonicalId)
      }
    }
  })

  log.stage('link', {
    status: 'done',
    detail: `${count(providerTracks.size, 'track')}; ${count(created, 'new canonical record')}, ${count(mergedByIsrc, 'linked')} to an existing one by ISRC`,
  })

  // 3. Pair collections: liked with liked, playlists by stored link or normalised name. Idempotent.
  log.stage('pair', { status: 'running', detail: null })
  report('pair', 'Pairing playlists')
  const collectionFor = pairCollections(fetched)

  // 4. Which canonical tracks sit in each collection on each side.
  const members = new Map<number, Record<ProviderId, Set<number> | null>>()
  for (const col of fetched) {
    const id = collectionFor.get(col)!
    const entry = members.get(id) ?? { spotify: null, tidal: null }
    entry[col.provider] = new Set(col.tracks.map(t => canonicalOf.get(`${col.provider}:${t.providerTrackId}`)!))
    members.set(id, entry)
  }
  const both = [...members.values()].filter(m => m.spotify && m.tidal).length
  log.stage('pair', { status: 'done', detail: `${count(members.size, 'collection')}: ${both} on both services, ${members.size - both} on one only` })

  // 5. Match canonical tracks that are missing on one side and have never been checked there.
  const allLinks = () => db.select().from(schema.trackLinks).all()
  const linkState = indexLinks(allLinks())
  const needs: { canonicalId: number, target: ProviderId, source: ProviderTrack, collectionId: number }[] = []
  const seen = new Set<string>()
  for (const [collectionId, sides] of members) {
    for (const p of PROVIDERS) {
      for (const canonicalId of sides[p] ?? []) {
        const target = other(p)
        if (sides[target]?.has(canonicalId) || linkState.get(`${canonicalId}:${target}`) || seen.has(`${canonicalId}:${target}`)) continue
        const source = sourceTrack(linkState, providerTracks, canonicalId, p)
        if (!source) continue
        seen.add(`${canonicalId}:${target}`)
        needs.push({ canonicalId, target, source, collectionId })
      }
    }
  }
  await matchMissing(needs, providers, members, canonicalOf, providerTracks, report, options, pauseFor, log)

  // 6. Diff every collection and build the view (provisional while paused: unmatched lookups show as pending).
  log.stage('diff', { status: 'running', detail: null })
  report('diff', 'Building the diff')
  const finalLinks = indexLinks(allLinks())
  const result: CollectionDiff[] = []
  const collectionRows = db.select().from(schema.collections).all()
  for (const [collectionId, sides] of members) {
    const collection = collectionRows.find(c => c.id === collectionId)!
    const planned = diffCollection({
      spotify: sides.spotify,
      tidal: sides.tidal,
      linkOn: (id, p) => {
        const l = finalLinks.get(`${id}:${p}`)
        return l && ({ status: l.status, method: l.method ?? undefined, confidence: l.confidence ?? undefined, reason: l.unmatchedReason ?? undefined } satisfies LinkInfo)
      },
    })
    const rows = planned.map((r): DiffRow => {
      const side = (p: ProviderId) => {
        if (!sides[p]?.has(r.canonicalTrackId)) return null
        const t = sourceTrack(finalLinks, providerTracks, r.canonicalTrackId, p)
        return t ? view(t) : null
      }
      const l = r.target ? finalLinks.get(`${r.canonicalTrackId}:${r.target}`) : undefined
      return {
        canonicalTrackId: r.canonicalTrackId,
        state: r.state,
        target: r.target,
        spotify: side('spotify'),
        tidal: side('tidal'),
        candidate: r.state === 'review' && l?.candidate ? { ...l.candidate, score: l.confidence ?? 0 } : undefined,
        method: r.link?.method,
        confidence: r.link?.confidence,
        reason: r.link?.reason,
      }
    })
    const counts = { in_sync: 0, add: 0, review: 0, pending: 0, unmatched: 0, total: rows.length } as Record<RowState, number> & { total: number }
    for (const row of rows) counts[row.state]++
    result.push({
      key: String(collectionId), kind: collection.kind, name: collection.name,
      onSpotify: sides.spotify !== null, onTidal: sides.tidal !== null, counts, rows,
    })
  }

  result.sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked') || a.name.localeCompare(b.name))
  const totals = { add: 0, review: 0, pending: 0, unmatched: 0 }
  for (const c of result) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += c.counts[k]
  log.stage('diff', {
    status: 'done',
    detail: `${count(totals.add, 'add')}, ${count(totals.review, 'review')}, ${totals.pending.toLocaleString('en-GB')} not checked yet, ${totals.unmatched.toLocaleString('en-GB')} unmatched${state.pause ? ' (provisional)' : ''}`,
  })
  log.flush()
  return { collections: result, pause: state.pause, requests: requests() }
}

/** Preferred link per canonical track and provider; matched links win over placeholders. */
function indexLinks(rows: LinkRow[]): Map<string, LinkRow> {
  const out = new Map<string, LinkRow>()
  for (const l of rows) {
    const key = `${l.canonicalTrackId}:${l.provider}`
    const current = out.get(key)
    if (!current || (l.isPreferred && !current.isPreferred) || (l.status === 'matched' && current.status !== 'matched')) out.set(key, l)
  }
  return out
}

function sourceTrack(links: Map<string, LinkRow>, tracks: Map<string, ProviderTrack>, canonicalId: number, p: ProviderId): ProviderTrack | undefined {
  const l = links.get(`${canonicalId}:${p}`)
  return l?.providerTrackId ? tracks.get(`${p}:${l.providerTrackId}`) : undefined
}

function pairCollections(fetched: FetchedCollection[]): Map<FetchedCollection, number> {
  const db = useDb()
  const out = new Map<FetchedCollection, number>()
  const existing = db.select({ link: schema.collectionLinks, collection: schema.collections }).from(schema.collectionLinks)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.collectionLinks.collectionId)).all()

  const likedId = existing.find(e => e.collection.kind === 'liked')?.collection.id
    ?? db.insert(schema.collections).values({ kind: 'liked', name: 'Liked songs' }).returning().get().id

  // Collections created this run, so a Tidal playlist can pair with a Spotify one seen moments earlier.
  const byName = new Map<string, { id: number, providers: Set<ProviderId> }>()
  for (const e of existing.filter(e => e.collection.kind === 'playlist')) {
    const entry = byName.get(normaliseText(e.collection.name)) ?? { id: e.collection.id, providers: new Set() }
    entry.providers.add(e.link.provider)
    byName.set(normaliseText(e.collection.name), entry)
  }

  for (const col of fetched) {
    if (col.kind === 'liked') {
      if (!existing.some(e => e.collection.kind === 'liked' && e.link.provider === col.provider)) {
        db.insert(schema.collectionLinks).values({ collectionId: likedId, provider: col.provider, providerCollectionId: null }).run()
      }
      out.set(col, likedId)
      continue
    }
    const linked = existing.find(e => e.link.provider === col.provider && e.link.providerCollectionId === col.providerCollectionId)
    if (linked) { out.set(col, linked.collection.id); continue }

    const name = normaliseText(col.name)
    let entry = byName.get(name)
    if (!entry || entry.providers.has(col.provider)) {
      entry = { id: db.insert(schema.collections).values({ kind: 'playlist', name: col.name }).returning().get().id, providers: new Set() }
      byName.set(name, entry)
    }
    db.insert(schema.collectionLinks).values({ collectionId: entry.id, provider: col.provider, providerCollectionId: col.providerCollectionId }).run()
    entry.providers.add(col.provider)
    out.set(col, entry.id)
  }
  return out
}

interface Need { canonicalId: number, target: ProviderId, source: ProviderTrack, collectionId: number }

async function matchMissing(
  needs: Need[],
  providers: Record<ProviderId, MusicProvider>,
  members: Map<number, Record<ProviderId, Set<number> | null>>,
  canonicalOf: Map<string, number>,
  providerTracks: Map<string, ProviderTrack>,
  report: Report,
  options: SyncOptions,
  pauseFor: (provider: ProviderId, reason: RunPause['reason'], error?: QuotaError) => RunPause,
  log: RunLog,
) {
  const db = useDb()
  const taken = new Set(db.select({ p: schema.trackLinks.provider, id: schema.trackLinks.providerTrackId }).from(schema.trackLinks).all()
    .filter(r => r.id).map(r => `${r.p}:${r.id}`))
  // Each result is saved at once: that is the match stage's checkpoint. Unsaved needs show as pending.
  const save = (n: Need, values: Partial<typeof schema.trackLinks.$inferInsert>) => {
    db.insert(schema.trackLinks).values({ canonicalTrackId: n.canonicalId, provider: n.target, status: 'unmatched', lastCheckedAt: now(), ...values }).run()
  }
  const reviewOrUnmatched = (n: Need, candidates: ProviderTrack[]) => {
    const best = bestCandidate(n.source, candidates)
    if (best && best.breakdown.score >= REVIEW_FLOOR) {
      save(n, { status: 'review', method: 'fuzzy', confidence: best.breakdown.score, candidateTrackId: best.track.providerTrackId, candidate: view(best.track) })
      return true
    }
    return best ? 'low_confidence' as const : false
  }

  let done = 0
  const total = needs.length
  for (const target of PROVIDERS) {
    const key = `match:${target}` as const
    const forTarget = needs.filter(n => n.target === target)
    if (!forTarget.length) {
      log.stage(key, { status: 'skipped', done: 0, total: 0, detail: 'Nothing new to look up' })
      continue
    }
    const blocked = quotaBlockedUntil(target)
    if (blocked) {
      pauseFor(target, 'quota')
      log.stage(key, { status: 'paused', done: 0, total: forTarget.length, detail: `${count(forTarget.length, 'track')} waiting; ${names[target]} rate limited until ${at(blocked)}` })
      log.event('warn', key, `Skipped: ${names[target]} is rate limited until ${at(blocked)}`)
      continue
    }

    const provider = providers[target]
    const budget = options.lookupBudget[target]
    let used = 0
    const tally = { matched: 0, review: 0, noMatch: 0, start: done }
    const progress = () => `${tally.matched.toLocaleString('en-GB')} matched by ISRC, ${tally.review} for review, ${tally.noMatch.toLocaleString('en-GB')} no match; ${count(used, 'request')}`
    log.stage(key, { status: 'running', done: 0, total: forTarget.length, detail: `${count(forTarget.length, 'track')} to look up` })
    log.event('info', key, `Looking up ${count(forTarget.length, 'track')} on ${names[target]}${Number.isFinite(budget) ? `, up to ${count(budget, 'request')} this run` : ''}`)
    const afford = (cost: number) => {
      if (used + cost <= budget) { used += cost; return true }
      const pause = pauseFor(target, 'budget')
      const left = forTarget.length - (done - tally.start)
      log.stage(key, { status: 'paused', detail: `${progress()}. Budget spent; resumes at ${at(pause.resumeAt)}` })
      log.event('warn', key, `Lookup budget of ${count(budget, 'request')} spent with ${count(left, 'track')} left. Resumes at ${at(pause.resumeAt)}`)
      return false
    }
    let stopped = false

    try {
      // One request's worth of ISRCs per batch (Spotify 1, Tidal 20): a quota error loses at most one
      // batch, and every result before it is already saved.
      batches: for (const batch of chunk(forTarget, provider.isrcBatchSize)) {
        const isrcs = [...new Set(batch.map(n => n.source.isrc).filter((i): i is string => Boolean(i)))]
        // Budget against at least one request up front, then charge what the lookup actually cost.
        if (isrcs.length && !afford(1)) { stopped = true; break }
        report('match', `Looking up ISRCs on ${names[target]}`, done, total)
        const lookup = isrcs.length ? await provider.findByIsrcs(isrcs) : null
        if (lookup) used += lookup.requests - 1
        const byIsrc = lookup?.tracks ?? new Map<string, ProviderTrack[]>()

        for (const n of batch) {
          report('match', `Matching "${n.source.title}" on ${names[target]}`, ++done, total)
          log.stage(key, { done: done - tally.start, detail: progress() })
          const hit = n.source.isrc ? pickIsrcResult(n.source, (byIsrc.get(n.source.isrc) ?? []).filter(t => !taken.has(`${target}:${t.providerTrackId}`))) : null
          if (hit) {
            save(n, { providerTrackId: hit.providerTrackId, status: 'matched', method: 'isrc', confidence: 1, isPreferred: true })
            taken.add(`${target}:${hit.providerTrackId}`)
            tally.matched++
            continue
          }

          // Fuzzy, in memory first: tracks in the same collection that exist only on the target side.
          const sides = members.get(n.collectionId)!
          const local = [...providerTracks.entries()]
            .filter(([key]) => key.startsWith(`${target}:`))
            .filter(([key]) => { const c = canonicalOf.get(key)!; return sides[target]?.has(c) && !sides[other(target)]?.has(c) })
            .map(([, t]) => t)
          if (reviewOrUnmatched(n, local) === true) { tally.review++; continue }

          if (!options.fuzzySearch) {
            save(n, { unmatchedReason: 'no_isrc_match' })
            tally.noMatch++
            continue
          }

          // Then the target's search.
          if (!afford(1)) { stopped = true; break batches }
          const { base } = splitTitle(n.source.title, n.source.version)
          const fromSearch = reviewOrUnmatched(n, await provider.search(`${n.source.artists[0] ?? ''} ${base}`.trim()))
          if (fromSearch === true) { tally.review++; continue }
          save(n, { unmatchedReason: fromSearch ? 'low_confidence' : 'not_found' })
          tally.noMatch++
        }
      }
      if (!stopped) log.stage(key, { status: 'done', done: forTarget.length, detail: progress() })
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error
      const pause = pauseFor(target, 'quota', error)
      log.stage(key, { status: 'paused', detail: `${progress()}. Rate limited; resumes at ${at(pause.resumeAt)}` })
      log.event('warn', key, `${error.message}. Every match so far is saved; resumes at ${at(pause.resumeAt)}`)
    }
    const mode = provider.lookupMode?.()
    if (mode) log.event('info', key, mode)
  }
}
