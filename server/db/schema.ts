// Canonical store (plan: "Data model"). V0 holds tracks, links, collections, accounts and runs;
// memberships, snapshots and pending actions arrive with the queue in M4.
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { LinkMethod, LinkStatus, ProviderId, SyncResult, UnmatchedReason } from '../../shared/types'

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
  updatedAt: text('updated_at').notNull(),
})

export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').$type<'sync' | 'apply'>().notNull(),
  trigger: text('trigger').$type<'manual' | 'schedule'>().notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
  error: text('error'),
  counts: text('counts', { mode: 'json' }).$type<Record<string, number>>(),
  /** V0: the computed diff, shown by the library screen until the queue replaces it in M4. */
  result: text('result', { mode: 'json' }).$type<SyncResult['collections']>(),
})
