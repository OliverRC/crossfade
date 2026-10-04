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
  /** False when the service still lists the song but no longer offers it. Absent means available. */
  available?: boolean
}

/**
 * owned: yours. collaborative: someone else's that you can edit; read, linked and pushed like your own.
 * followed: someone else's that you only follow. Spotify does not let apps read its songs (403), so it is listed, never read or pushed.
 */
export type PlaylistAccess = 'owned' | 'collaborative' | 'followed'

export interface ProviderPlaylist {
  providerCollectionId: string
  name: string
  /** Absent means owned (lists saved before followed playlists were kept). */
  access?: PlaylistAccess
  /** The owner's display name, for playlists that are not yours. */
  ownerName?: string | null
}

export type LinkStatus = 'matched' | 'review' | 'unmatched' | 'ignored'
/** metadata: equal cleaned-up title, artists and version, and lengths within 2 seconds (docs/decisions/0008). */
export type LinkMethod = 'origin' | 'isrc' | 'metadata' | 'fuzzy' | 'manual'
/** no_isrc_match: the ISRC lookup missed and fuzzy search was not tried, so a later pass can still find it. */
export type UnmatchedReason = 'not_found' | 'no_isrc_match' | 'low_confidence' | 'ignored'

/** A song's overall state on the Library page; each has its own glyph as well as a colour. */
export type RowState = 'in_sync' | 'add' | 'remove' | 'conflict' | 'unavailable' | 'unknown'

export interface TrackView {
  title: string
  artists: string[]
  durationMs: number
  isrc: string | null
}

export interface StatusCounts {
  inSync: number
  conflicts: number
  /** Per service: songs a push would add and remove, and songs it lists but no longer offers. */
  add: Record<ProviderId, number>
  remove: Record<ProviderId, number>
  unavailable: Record<ProviderId, number>
  /** Of those adds and removals, the ones staged for the next push (docs/decisions/0007). */
  staged: { add: Record<ProviderId, number>, remove: Record<ProviderId, number> }
  /** Of the adds, songs the other service lists but does not offer: push still looks for them by ISRC. */
  addUnavailable: Record<ProviderId, number>
}

export interface StatusRowView {
  canonicalTrackId: number
  state: RowState
  track: TrackView
  main: 'active' | 'removed'
  spotify: SideState
  tidal: SideState
  conflict: { id: number, provider: ProviderId, change: 'added' | 'removed' } | null
  /** The change a push would make on each service, and whether it is staged. */
  change: Record<ProviderId, 'add' | 'remove' | null>
  staged: Record<ProviderId, boolean>
}

export interface HoldView {
  id: number
  provider: ProviderId
  reason: HoldReason
  before: number
  removing: number
  detectedAt: string
  runId: number
}

export interface CollectionStatusView {
  key: string
  kind: 'liked' | 'playlist'
  name: string
  /** The collection exists on the service and Crossfade can read it. */
  on: Record<ProviderId, boolean>
  /** Someone else's playlist on the service: collaborative ones are read and pushed; followed ones cannot be read. */
  shared: Partial<Record<ProviderId, { access: 'collaborative' | 'followed', ownerName: string | null }>>
  /** Songs in main's copy of this collection. */
  songs: number
  /** Other collections in main with the same name: usually a second copy on one service. */
  namesakes: { key: string, on: Record<ProviderId, boolean>, songs: number }[]
  counts: StatusCounts
  holds: HoldView[]
}

export interface ServiceStatusView {
  /** When the service was last pulled in full; null before its first pull. */
  pulledAt: string | null
  /** The latest pull of this service. */
  run: RunStatus | null
}

export interface LibraryView {
  services: Record<ProviderId, ServiceStatusView>
  collections: CollectionStatusView[]
  totals: StatusCounts & { held: number }
  /** Rows of the requested collection, or the first one. */
  selected: { key: string, rows: StatusRowView[] } | null
  /** Songs added or removed in main by each of the last 20 pulls, oldest first. */
  recent: number[]
}

/** One collection's staged changes for one service. */
export interface StagedCollectionView {
  key: string
  kind: 'liked' | 'playlist'
  name: string
  /** The playlist is not on the service yet: push creates it first. */
  createsPlaylist: boolean
  /** Someone else's collaborative playlist: a push edits theirs. */
  ownerName: string | null
  add: StagedTrackView[]
  remove: StagedTrackView[]
}

/** A staged song, with why the last push could not apply it, if it tried. */
export interface StagedTrackView extends TrackView {
  canonicalTrackId: number
  error: string | null
  attempts: number
}

/** What the next push to each service would do (docs/decisions/0007). */
export type StagedView = Record<ProviderId, { collections: StagedCollectionView[], add: number, remove: number }>

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
  /** Requests sent to this service by its latest pull, across its resumes. */
  requestsLastRun: number | null
  scopes: string[]
}

export type StageKey = 'fetch:spotify' | 'fetch:tidal' | 'link' | 'pair' | 'match:tidal' | 'match:spotify' | 'diff' | 'merge' | 'cleanup' | 'lookup' | 'write'
export interface StageInfo { key: StageKey, label: string, help: string }

const STAGE_INFO: Record<StageKey, Omit<StageInfo, 'key'>> = {
  'fetch:spotify': { label: 'Fetch Spotify', help: 'Liked songs and every playlist you own or collaborate on, saved as each one arrives. Playlists you only follow are listed but not read: Spotify does not let apps read them.' },
  'fetch:tidal': { label: 'Fetch Tidal', help: 'Liked songs and every playlist you own, saved as each one arrives. Songs Tidal lists but will not play in your country are kept, marked unavailable.' },
  'link': { label: 'Link tracks', help: 'Every track becomes one canonical record; equal ISRCs on both services share one, then songs with the same title, artists, version and length (within 2 seconds).' },
  'pair': { label: 'Pair playlists', help: 'Liked songs with liked songs; playlists by a previous pairing or by name.' },
  'match:tidal': { label: 'Match on Tidal', help: 'Find Spotify-only tracks on Tidal by ISRC, 20 per request.' },
  'match:spotify': { label: 'Match on Spotify', help: 'Find Tidal-only tracks on Spotify by ISRC. Rationed: Spotify has a quota.' },
  'diff': { label: 'Build the diff', help: 'What a merge would add on each side. Nothing is written.' },
  'merge': { label: 'Merge into main', help: 'Changes since the last pull become changes in main. Conflicts and suspicious reads are held for you.' },
  'lookup': { label: 'Find songs', help: 'Each staged song to add is found on the service: by an earlier link, or by ISRC. A song with no match stays staged with the reason.' },
  'write': { label: 'Write', help: 'Each playlist is read again first, and only what it still needs is written. Results are saved song by song; a failure stays staged for the next push.' },
  'cleanup': { label: 'Clean up playlists', help: 'Merge exact copies into the one you keep, then delete the rest; delete empty playlists. Every deleted playlist is saved first.' },
}

/** cleanup: the playlist cleanup, which writes to Tidal (docs/decisions/0004). */
export type RunKind = 'sync' | 'apply' | 'pull' | 'push' | 'cleanup'

/** The stages a run goes through: a pull fetches one service; the V0 sync fetched both and matched. */
export function stagesFor(run: { kind: RunKind, provider: ProviderId | null }): StageInfo[] {
  const keys: StageKey[] = run.kind === 'cleanup'
    ? ['cleanup']
    : run.kind === 'push'
      ? ['lookup', 'write']
    : run.kind === 'pull' && run.provider
      ? [`fetch:${run.provider}`, 'link', 'pair', 'merge']
      : ['fetch:spotify', 'fetch:tidal', 'link', 'pair', 'match:tidal', 'match:spotify', 'diff']
  return keys.map(key => ({ key, ...STAGE_INFO[key] }))
}

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
  kind: RunKind
  provider: ProviderId | null
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
  /** The service the run in progress or last run pulled. */
  provider: ProviderId | null
  rev: number
  /** The push in progress or last finished, step by step per collection; null for a pull. */
  push?: PushProgress | null
}

export type PushStepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

/** One step of one collection's push plan: how far it got and what went wrong. */
export interface PushStepProgress {
  status: PushStepStatus
  total: number
  done: number
  failed: number
  detail: string | null
}

/** A push to one service: per collection key, its add and remove steps (docs/decisions/0007). */
export interface PushProgress {
  provider: ProviderId
  collections: Record<string, { name: string, add?: PushStepProgress, remove?: PushStepProgress }>
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

/** One song in a service's snapshot of a collection. */
export interface SnapshotItem {
  canonicalTrackId: number
  providerTrackId: string
  /** False when the service lists the song but no longer offers it. */
  available: boolean
}

export type HoldReason = 'empty' | 'mass_removal' | 'gone'

/**
 * A song's state on one service compared with main (docs/decisions/0005).
 * present: there and in main. missing: in main, not there (a push adds it). extra: removed from main, still there
 * (a push removes it). unavailable: listed but no longer offered. absent: removed from main and not there.
 * unknown: the service has not been pulled yet. followed: the service has it as someone else's playlist you only
 * follow, which it does not let apps read; never pushed.
 */
export type SideState = 'present' | 'missing' | 'extra' | 'unavailable' | 'absent' | 'unknown' | 'followed'
