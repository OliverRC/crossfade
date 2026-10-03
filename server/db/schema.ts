// Canonical store (plan: "Data model"). V0 holds tracks, links, collections, accounts, runs and
// run checkpoints; memberships, snapshots and pending actions arrive with the queue in M4.
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { LinkMethod, LinkStatus, ProviderId, ProviderPlaylist, ProviderTrack, RunPause, RunStages, StageKey, SyncResult, UnmatchedReason } from '../../shared/types'

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
  isOwned: integer('is_owned', { mode: 'boolean' }).notNull().default(true),
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
  kind: text('kind').$type<'sync' | 'apply'>().notNull(),
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
  /** V0: the computed diff (provisional while paused), shown until the queue replaces it in M4. */
  result: text('result', { mode: 'json' }).$type<SyncResult['collections']>(),
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
