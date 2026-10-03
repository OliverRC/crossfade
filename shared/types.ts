export type ProviderId = 'spotify' | 'tidal'
export const PROVIDERS: ProviderId[] = ['spotify', 'tidal']

export interface ProviderTrack {
  providerTrackId: string
  isrc: string | null
  title: string
  artists: string[]
  album: string
  durationMs: number
  explicit: boolean
  version: string | null
}

export interface ProviderPlaylist {
  providerCollectionId: string
  name: string
}

export type LinkStatus = 'matched' | 'review' | 'unmatched' | 'ignored'
export type LinkMethod = 'origin' | 'isrc' | 'fuzzy' | 'manual'
/** no_isrc_match: the ISRC lookup missed and fuzzy search was not tried, so a later pass can still find it. */
export type UnmatchedReason = 'not_found' | 'no_isrc_match' | 'low_confidence' | 'ignored'

export type RowState = 'in_sync' | 'add' | 'review' | 'pending' | 'unmatched'

export interface TrackView {
  title: string
  artists: string[]
  durationMs: number
  isrc: string | null
}

export interface DiffRow {
  canonicalTrackId: number
  state: RowState
  /** The service the change would be written to (absent when in sync). */
  target?: ProviderId
  spotify: TrackView | null
  tidal: TrackView | null
  /** Fuzzy candidate on the target service, for review rows. */
  candidate?: TrackView & { score: number }
  method?: LinkMethod
  confidence?: number
  reason?: UnmatchedReason
}

export interface CollectionDiff {
  key: string
  kind: 'liked' | 'playlist'
  name: string
  onSpotify: boolean
  onTidal: boolean
  counts: Record<RowState, number> & { total: number }
  rows: DiffRow[]
}

export interface SyncResult {
  runId: number
  finishedAt: string
  collections: CollectionDiff[]
}

export interface QuotaView {
  /** True while requests are held back; false once the retry time has passed. */
  blocked: boolean
  hitAt: string | null
  retryAt: string
  /** retry-after: the service said when; estimate: it did not, so Crossfade probes again then. */
  source: 'retry-after' | 'estimate'
  message: string | null
}

export interface ConnectionView {
  provider: ProviderId
  configured: boolean
  redirectUri: string
  connected: boolean
  providerUserId: string | null
  needsReconnect: boolean
  quota: QuotaView | null
  /** Requests sent to this service by the latest sync run, across its resumes. */
  requestsLastRun: number | null
  scopes: string[]
}

export type StageKey = 'fetch:spotify' | 'fetch:tidal' | 'link' | 'pair' | 'match:tidal' | 'match:spotify' | 'diff'
export const STAGES: { key: StageKey, label: string, help: string }[] = [
  { key: 'fetch:spotify', label: 'Fetch Spotify', help: 'Liked songs and every playlist you own, saved as each one arrives.' },
  { key: 'fetch:tidal', label: 'Fetch Tidal', help: 'Liked songs and every playlist you own, saved as each one arrives.' },
  { key: 'link', label: 'Link tracks', help: 'Every track becomes one canonical record; equal ISRCs on both services share one.' },
  { key: 'pair', label: 'Pair playlists', help: 'Liked songs with liked songs; playlists by a previous pairing or by name.' },
  { key: 'match:tidal', label: 'Match on Tidal', help: 'Find Spotify-only tracks on Tidal by ISRC, 20 per request.' },
  { key: 'match:spotify', label: 'Match on Spotify', help: 'Find Tidal-only tracks on Spotify by ISRC. Rationed: Spotify has a quota.' },
  { key: 'diff', label: 'Build the diff', help: 'What a merge would add on each side. Nothing is written.' },
]

export type StageStatus = 'waiting' | 'running' | 'done' | 'paused' | 'failed' | 'skipped'

export interface StageState {
  status: StageStatus
  startedAt: string | null
  finishedAt: string | null
  done: number
  total: number
  detail: string | null
}

export type RunStages = Partial<Record<StageKey, StageState>>

export interface RunEvent {
  id: number
  at: string
  level: 'info' | 'warn' | 'error'
  stage: StageKey | null
  message: string
}

export interface RunSummary {
  id: number
  trigger: 'manual' | 'schedule'
  status: 'running' | 'paused' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  attempts: number
  pause: RunPause | null
  error: string | null
  counts: Record<string, number> | null
  stages: RunStages
}

export interface RunDetail extends RunSummary {
  events: RunEvent[]
}

export interface RunPause {
  provider: ProviderId
  /** quota: the service refused us. budget: this run's lookup allowance is spent. */
  reason: 'quota' | 'budget'
  resumeAt: string
  message: string
}

export interface RunStatus {
  id: number
  status: 'running' | 'paused' | 'succeeded' | 'failed'
  phase: string | null
  pause: RunPause | null
  error: string | null
  pending: number
}

export interface RunProgress {
  running: boolean
  phase: string
  message: string
  done: number
  total: number
  error: string | null
  /** When the next automatic run is scheduled. */
  resumeAt: string | null
  /** The run in progress or last run, and a counter bumped on every stage or event change. */
  runId: number | null
  rev: number
}

/** Playlist cleanup (docs/decisions/0004). exact: copies (merged); contained and different are shown only. */
export type DuplicateTier = 'exact' | 'contained' | 'different'

export interface PlaylistCopyView {
  id: string
  name: string
  url: string
  items: number
  /** Items no other copy has. */
  unique: number
  /** Items the merged playlist would hold if this copy is the one kept. */
  afterIfKept: number
}

/** A playlist on the other service, shown beside a cleanup row; cleanup never changes it. */
export interface PlaylistRef {
  provider: ProviderId
  id: string
  name: string
  url: string
  items: number
}

export interface DuplicateGroupView {
  key: string
  provider: ProviderId
  tier: DuplicateTier
  name: string
  /** Largest first: the default copy to keep. */
  copies: PlaylistCopyView[]
  /** Distinct items in every copy, and across all copies. */
  shared: number
  union: number
  /** Cleanup can merge it: an exact copy on a service cleanup writes to. */
  actionable: boolean
  /** Same-named playlists on the other service. */
  counterpart: PlaylistRef[]
}

export interface EmptyPlaylistView {
  key: string
  provider: ProviderId
  id: string
  name: string
  url: string
  actionable: boolean
  counterpart: PlaylistRef[]
}

export interface CleanupOutcome {
  key: string
  kind: 'merge' | 'empty'
  name: string
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed' | 'not_attempted'
  detail: string | null
  added: number
  deleted: number
  /** Songs Tidal no longer offers, remembered instead of carried over. */
  pulled: number
}

export interface CleanupJobView {
  running: boolean
  startedAt: string
  finishedAt: string | null
  error: string | null
  outcomes: CleanupOutcome[]
}

export interface CleanupView {
  /** The sync whose fetched playlists this is based on, per service; null when none fetched them all. */
  sources: Record<ProviderId, { runId: number, fetchedAt: string } | null>
  groups: DuplicateGroupView[]
  empty: EmptyPlaylistView[]
  job: CleanupJobView | null
  /** Deleted playlists saved so far. */
  backups: number
  /** Songs pulled from the service, remembered against the playlist they belong in. */
  pulled: PulledSongView[]
}

export interface PulledSongView {
  provider: ProviderId
  isrc: string | null
  /** From the canonical library when the other service knows the song; the pulled one has no details left. */
  title: string | null
  artists: string[]
  playlistName: string
  playlistUrl: string
  foundAt: string
}
