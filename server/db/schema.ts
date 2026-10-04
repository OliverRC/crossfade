// Canonical store (plan: "Data model"; docs/decisions/0005). Main is canonical tracks, collections and
// memberships; each service has a snapshot per collection, the last state a pull read from it.
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { HoldReason, RunKind, SnapshotItem, LinkMethod, LinkStatus, PlaylistAccess, ProviderId, ProviderPlaylist, ProviderTrack, RunPause, RunStages, StageKey, UnmatchedReason } from '../../shared/types'

const createdAt = () => text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)

export const canonicalTracks = sqliteTable('canonical_tracks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  isrc: text('isrc'),
  title: text('title').notNull(),
  artists: text('artists', { mode: 'json' }).$type<string[]>().notNull(),
  album: text('album').notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: createdAt(),
}, t => [index('canonical_tracks_isrc').on(t.isrc)])

export const trackLinks = sqliteTable('track_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  canonicalTrackId: integer('canonical_track_id').notNull().references(() => canonicalTracks.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<ProviderId>().notNull(),
  /** Null while unmatched or under review. */
  providerTrackId: text('provider_track_id'),
  status: text('status').$type<LinkStatus>().notNull(),
  method: text('method').$type<LinkMethod>(),
  confidence: real('confidence'),
  unmatchedReason: text('unmatched_reason').$type<UnmatchedReason>(),
  /** Best fuzzy candidate awaiting review: provider track ID plus a display copy. */
  candidateTrackId: text('candidate_track_id'),
  candidate: text('candidate', { mode: 'json' }).$type<{ title: string, artists: string[], durationMs: number, isrc: string | null }>(),
  isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
  lastCheckedAt: text('last_checked_at'),
}, t => [
  uniqueIndex('track_links_provider_track').on(t.provider, t.providerTrackId),
  index('track_links_canonical').on(t.canonicalTrackId, t.provider),
])

export const collections = sqliteTable('collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').$type<'liked' | 'playlist'>().notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const collectionLinks = sqliteTable('collection_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<ProviderId>().notNull(),
  /** Null for liked songs. */
  providerCollectionId: text('provider_collection_id'),
  /** followed: someone else's playlist the service will not let us read; listed only, never read or pushed. */
  access: text('access').$type<PlaylistAccess>().notNull().default('owned'),
  /** The owner's display name when the playlist is not yours. */
  ownerName: text('owner_name'),
}, t => [uniqueIndex('collection_links_provider_collection').on(t.provider, t.providerCollectionId)])

export const providerAccounts = sqliteTable('provider_accounts', {
  provider: text('provider').$type<ProviderId>().primaryKey(),
  providerUserId: text('provider_user_id').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: text('expires_at').notNull(),
  scopes: text('scopes').notNull().default(''),
  country: text('country'),
  needsReconnect: integer('needs_reconnect', { mode: 'boolean' }).notNull().default(false),
  /** Set after a quota error; no requests are sent to this service before then. */
  quotaBlockedUntil: text('quota_blocked_until'),
  quotaHitAt: text('quota_hit_at'),
  /** retry-after: the service said when; estimate: it did not, so we picked a time to probe again. */
  quotaResetSource: text('quota_reset_source').$type<'retry-after' | 'estimate'>(),
  quotaMessage: text('quota_message'),
  updatedAt: text('updated_at').notNull(),
})

export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** sync: the V0 dry run. pull: read one service into main (docs/decisions/0005). */
  kind: text('kind').$type<RunKind>().notNull(),
  /** The service a pull or push works on; null for the V0 sync. */
  provider: text('provider').$type<ProviderId>(),
  trigger: text('trigger').$type<'manual' | 'schedule'>().notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  /** paused: stopped by a quota or lookup budget, resumes at `pause.resumeAt`. Only succeeded is complete. */
  status: text('status').$type<'running' | 'paused' | 'succeeded' | 'failed'>().notNull(),
  phase: text('phase'),
  /** Per-stage status and progress, for the run detail view. */
  stages: text('stages', { mode: 'json' }).$type<RunStages>(),
  /** How many times this run has started: 1, plus one per resume. */
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  pause: text('pause', { mode: 'json' }).$type<RunPause>(),
  /** Playlist lists per provider, saved before their contents are fetched. */
  playlists: text('playlists', { mode: 'json' }).$type<Partial<Record<ProviderId, ProviderPlaylist[]>>>(),
  counts: text('counts', { mode: 'json' }).$type<Record<string, number>>(),
  /** V0 syncs only: the dry-run diff they computed. Pulls leave it empty; the Library page reads main. */
  result: text('result', { mode: 'json' }).$type<unknown>(),
})

/** One collection fetched from one provider during a run, so a resumed run does not fetch it again. */
export const fetchCheckpoints = sqliteTable('fetch_checkpoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => syncRuns.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<ProviderId>().notNull(),
  kind: text('kind').$type<'liked' | 'playlist'>().notNull(),
  /** 'liked' or the provider playlist ID. */
  collectionKey: text('collection_key').notNull(),
  name: text('name').notNull(),
  tracks: text('tracks', { mode: 'json' }).$type<ProviderTrack[]>().notNull(),
  fetchedAt: text('fetched_at').notNull(),
}, t => [uniqueIndex('fetch_checkpoints_run_collection').on(t.runId, t.provider, t.collectionKey)])

/** Notable things that happened during a run: stage changes, collections fetched, pauses, errors. */
export const syncEvents = sqliteTable('sync_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => syncRuns.id, { onDelete: 'cascade' }),
  at: text('at').notNull(),
  level: text('level').$type<'info' | 'warn' | 'error'>().notNull(),
  stage: text('stage').$type<StageKey>(),
  message: text('message').notNull(),
}, t => [index('sync_events_run').on(t.runId, t.id)])

/** A playlist deleted by cleanup, saved first so it can be recreated (docs/decisions/0004). */
export const playlistBackups = sqliteTable('playlist_backups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').$type<ProviderId>().notNull(),
  playlistId: text('playlist_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  accessType: text('access_type'),
  /** Items in playlist order, as stored on the service. */
  items: text('items', { mode: 'json' }).$type<{ type: 'tracks' | 'videos', id: string, isrc: string | null }[]>().notNull(),
  /** empty: removed as empty; merged: its items were merged into `keptPlaylistId` first. */
  reason: text('reason').$type<'empty' | 'merged'>().notNull(),
  keptPlaylistId: text('kept_playlist_id'),
  savedAt: text('saved_at').notNull(),
  /** Set once the service confirmed the delete. */
  deletedAt: text('deleted_at'),
})

/**
 * A song that belongs in a playlist but that the service no longer offers, so it could not be carried into the
 * playlist kept by cleanup. Remembered so it can be re-added if it returns (docs/decisions/0004).
 */
export const unavailableItems = sqliteTable('unavailable_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').$type<ProviderId>().notNull(),
  itemType: text('item_type').$type<'tracks' | 'videos'>().notNull(),
  itemId: text('item_id').notNull(),
  isrc: text('isrc'),
  /** The playlist the song belongs in, and the deleted copy it was found in. */
  playlistId: text('playlist_id').notNull(),
  playlistName: text('playlist_name').notNull(),
  foundInPlaylistId: text('found_in_playlist_id').notNull(),
  foundAt: text('found_at').notNull(),
  /** Set when the song is back in the playlist. */
  restoredAt: text('restored_at'),
}, t => [uniqueIndex('unavailable_items_playlist_item').on(t.provider, t.playlistId, t.itemId)])

/** Main: a song belongs in a collection (active) or was removed from it (a tombstone, kept so a stale read cannot re-add it). */
export const memberships = sqliteTable('memberships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  canonicalTrackId: integer('canonical_track_id').notNull().references(() => canonicalTracks.id, { onDelete: 'cascade' }),
  state: text('state').$type<'active' | 'removed'>().notNull(),
  changedAt: text('changed_at').notNull(),
  /** The service whose pull made the change, or user. */
  changedBy: text('changed_by').$type<ProviderId | 'user'>().notNull(),
}, t => [uniqueIndex('memberships_collection_track').on(t.collectionId, t.canonicalTrackId)])

/** What a service held in one collection at its last pull: the base the next pull compares against. */
export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').$type<ProviderId>().notNull(),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  /** Null for liked songs. */
  providerCollectionId: text('provider_collection_id'),
  takenAt: text('taken_at').notNull(),
  items: text('items', { mode: 'json' }).$type<SnapshotItem[]>().notNull(),
  runId: integer('run_id'),
}, t => [uniqueIndex('snapshots_provider_collection').on(t.provider, t.collectionId)])

/** A pull that would undo a newer change in main stops on that song until Oliver decides. */
export const conflicts = sqliteTable('conflicts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  canonicalTrackId: integer('canonical_track_id').notNull().references(() => canonicalTracks.id, { onDelete: 'cascade' }),
  /** The service whose pull found it, and what that service did. */
  provider: text('provider').$type<ProviderId>().notNull(),
  change: text('change').$type<'added' | 'removed'>().notNull(),
  detectedAt: text('detected_at').notNull(),
  resolvedAt: text('resolved_at'),
  /** keep: the song stays in main. remove: it leaves main. */
  resolution: text('resolution').$type<'keep' | 'remove'>(),
}, t => [index('conflicts_open').on(t.collectionId, t.resolvedAt)])

/** A collection a pull did not merge because the read looked wrong (sanity guard). */
export const pullHolds = sqliteTable('pull_holds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').$type<ProviderId>().notNull(),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  runId: integer('run_id').notNull(),
  /** empty: came back empty. mass_removal: would lose too many songs. gone: the playlist is no longer on the service. */
  reason: text('reason').$type<HoldReason>().notNull(),
  before: integer('before').notNull(),
  removing: integer('removing').notNull(),
  detectedAt: text('detected_at').notNull(),
  resolvedAt: text('resolved_at'),
  /**
   * accepted: Oliver confirmed the removals. superseded: a later pull no longer tripped the guard.
   * kept / removed: for a playlist gone from the service, main kept it or removed its songs.
   */
  resolution: text('resolution').$type<'accepted' | 'superseded' | 'kept' | 'removed'>(),
})

/**
 * A change picked for the next push to one service (docs/decisions/0007). The change itself is derived from main and
 * the service's snapshot; a staged row whose change no longer exists is stale and is pruned.
 */
export const stagedChanges = sqliteTable('staged_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  canonicalTrackId: integer('canonical_track_id').notNull().references(() => canonicalTracks.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<ProviderId>().notNull(),
  change: text('change').$type<'add' | 'remove'>().notNull(),
  stagedAt: text('staged_at').notNull(),
}, t => [uniqueIndex('staged_changes_collection_track_provider').on(t.collectionId, t.canonicalTrackId, t.provider)])
