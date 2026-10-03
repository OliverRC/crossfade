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
export type UnmatchedReason = 'not_found' | 'low_confidence' | 'ignored'

export type RowState = 'in_sync' | 'add' | 'review' | 'unmatched'

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

export interface ConnectionView {
  provider: ProviderId
  configured: boolean
  redirectUri: string
  connected: boolean
  providerUserId: string | null
  needsReconnect: boolean
  scopes: string[]
}

export interface RunProgress {
  running: boolean
  phase: string
  message: string
  done: number
  total: number
  error: string | null
}
