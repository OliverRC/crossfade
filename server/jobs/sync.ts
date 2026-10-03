// V0 dry-run sync: fetch both libraries, build the canonical store, match what is missing, and
// save the union-merge diff. Reads from Spotify and Tidal only; nothing is written to either service.
import { eq } from 'drizzle-orm'
import { PROVIDERS, type CollectionDiff, type DiffRow, type ProviderId, type ProviderTrack, type RowState, type TrackView } from '../../shared/types'
import { diffCollection, type LinkInfo } from '../core/diff'
import { normaliseText, splitTitle } from '../core/normalise'
import { REVIEW_FLOOR, bestCandidate, pickIsrcResult } from '../core/score'
import { getProvider } from '../providers'
import type { MusicProvider } from '../providers/types'
import { schema, useDb } from '../utils/db'

type Report = (phase: string, message: string, done?: number, total?: number) => void
type LinkRow = typeof schema.trackLinks.$inferSelect

interface FetchedCollection { provider: ProviderId, kind: 'liked' | 'playlist', providerCollectionId: string | null, name: string, tracks: ProviderTrack[] }

const other = (p: ProviderId): ProviderId => (p === 'spotify' ? 'tidal' : 'spotify')
const view = (t: ProviderTrack): TrackView => ({ title: t.version ? `${t.title} (${t.version})` : t.title, artists: t.artists, durationMs: t.durationMs, isrc: t.isrc })
const now = () => new Date().toISOString()

export async function runSync(
  report: Report,
  providers: Record<ProviderId, MusicProvider> = Object.fromEntries(PROVIDERS.map(p => [p, getProvider(p)])) as Record<ProviderId, MusicProvider>,
): Promise<CollectionDiff[]> {
  const db = useDb()

  // 1. Fetch both sides in full.
  const fetched: FetchedCollection[] = []
  for (const p of PROVIDERS) {
    report('fetch', `Reading ${p} liked songs`)
    fetched.push({ provider: p, kind: 'liked', providerCollectionId: null, name: 'Liked songs', tracks: await providers[p].getLikedTracks() })
    report('fetch', `Reading ${p} playlists`)
    const playlists = await providers[p].getOwnedPlaylists()
    for (const [i, pl] of playlists.entries()) {
      report('fetch', `Reading ${p} playlist "${pl.name}"`, i + 1, playlists.length)
      fetched.push({ provider: p, kind: 'playlist', providerCollectionId: pl.providerCollectionId, name: pl.name, tracks: await providers[p].getPlaylistTracks(pl.providerCollectionId) })
    }
  }

  // 2. Canonicalise: every provider track maps to one canonical track; equal ISRCs share one.
  report('canonical', 'Linking tracks by ISRC')
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

  // 3. Pair collections: liked with liked, playlists by stored link or normalised name.
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
  await matchMissing(needs, providers, members, canonicalOf, providerTracks, report)

  // 6. Diff every collection and build the view.
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
    const counts = { in_sync: 0, add: 0, review: 0, unmatched: 0, total: rows.length } as Record<RowState, number> & { total: number }
    for (const row of rows) counts[row.state]++
    result.push({
      key: String(collectionId), kind: collection.kind, name: collection.name,
      onSpotify: sides.spotify !== null, onTidal: sides.tidal !== null, counts, rows,
    })
  }

  return result.sort((a, b) => Number(b.kind === 'liked') - Number(a.kind === 'liked') || a.name.localeCompare(b.name))
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

async function matchMissing(
  needs: { canonicalId: number, target: ProviderId, source: ProviderTrack, collectionId: number }[],
  providers: Record<ProviderId, MusicProvider>,
  members: Map<number, Record<ProviderId, Set<number> | null>>,
  canonicalOf: Map<string, number>,
  providerTracks: Map<string, ProviderTrack>,
  report: Report,
) {
  const db = useDb()
  const taken = new Set(db.select({ p: schema.trackLinks.provider, id: schema.trackLinks.providerTrackId }).from(schema.trackLinks).all()
    .filter(r => r.id).map(r => `${r.p}:${r.id}`))
  const save = (n: typeof needs[number], values: Partial<typeof schema.trackLinks.$inferInsert>) => {
    db.insert(schema.trackLinks).values({ canonicalTrackId: n.canonicalId, provider: n.target, status: 'unmatched', lastCheckedAt: now(), ...values }).run()
  }
  const reviewOrUnmatched = (n: typeof needs[number], candidates: ProviderTrack[], method: 'fuzzy') => {
    const best = bestCandidate(n.source, candidates)
    if (best && best.breakdown.score >= REVIEW_FLOOR) {
      save(n, { status: 'review', method, confidence: best.breakdown.score, candidateTrackId: best.track.providerTrackId, candidate: view(best.track) })
      return true
    }
    return best ? 'low_confidence' as const : false
  }

  let done = 0
  const total = needs.length
  for (const target of PROVIDERS) {
    const forTarget = needs.filter(n => n.target === target)
    if (!forTarget.length) continue

    // ISRC lookup on the target service, batched.
    const isrcs = [...new Set(forTarget.map(n => n.source.isrc).filter((i): i is string => Boolean(i)))]
    report('match', `Looking up ${isrcs.length} ISRCs on ${target}`, done, total)
    const byIsrc = isrcs.length ? await providers[target].findByIsrcs(isrcs) : new Map<string, ProviderTrack[]>()

    for (const n of forTarget) {
      report('match', `Matching "${n.source.title}" on ${target}`, ++done, total)
      const hit = n.source.isrc ? pickIsrcResult(n.source, (byIsrc.get(n.source.isrc) ?? []).filter(t => !taken.has(`${target}:${t.providerTrackId}`))) : null
      if (hit) {
        save(n, { providerTrackId: hit.providerTrackId, status: 'matched', method: 'isrc', confidence: 1, isPreferred: true })
        taken.add(`${target}:${hit.providerTrackId}`)
        continue
      }

      // Fuzzy, in memory first: tracks in the same collection that exist only on the target side.
      const sides = members.get(n.collectionId)!
      const local = [...providerTracks.entries()]
        .filter(([key]) => key.startsWith(`${target}:`))
        .filter(([key]) => { const c = canonicalOf.get(key)!; return sides[target]?.has(c) && !sides[other(target)]?.has(c) })
        .map(([, t]) => t)
      const fromLibrary = reviewOrUnmatched(n, local, 'fuzzy')
      if (fromLibrary === true) continue

      // Then the target's search.
      const { base } = splitTitle(n.source.title, n.source.version)
      const results = await providers[target].search(`${n.source.artists[0] ?? ''} ${base}`.trim())
      const fromSearch = reviewOrUnmatched(n, results, 'fuzzy')
      if (fromSearch === true) continue
      save(n, { unmatchedReason: fromSearch ? 'low_confidence' : 'not_found' })
    }
  }
}
