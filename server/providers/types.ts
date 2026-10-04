import type { ProviderId, ProviderPlaylist, ProviderTrack } from '../../shared/types'
import type { IsrcLookup } from './spotify-isrc'

/**
 * The only code that talks to Spotify or Tidal implements this. Reads only; writes go through PushWriter.
 */
export interface MusicProvider {
  readonly id: ProviderId
  /** ISRCs handed to one findByIsrcs call (Spotify 5, Tidal 20): a quota error loses at most one call's results. */
  readonly isrcBatchSize: number
  /** Liked and playlist reads include songs the service still lists but no longer offers, with `available: false`. */
  getLikedTracks(): Promise<ProviderTrack[]>
  /** Playlists you own or collaborate on, plus (Spotify) ones you only follow, marked `followed` and never read. */
  getPlaylists(): Promise<ProviderPlaylist[]>
  getPlaylistTracks(playlistId: string): Promise<ProviderTrack[]>
  /** Each ISRC maps to every track found for it; `requests` is what the lookup cost. */
  findByIsrcs(isrcs: string[]): Promise<IsrcLookup>
  search(query: string): Promise<ProviderTrack[]>
  /** How lookups are being made, when that was learned at runtime (Spotify's OR support). */
  lookupMode?(): string | null
}

/** A song as a playlist holds it: the service's track ID and the entry's own ID, which removal needs on Tidal. */
export interface PlaylistEntry {
  trackId: string
  /** Tidal's per-entry ID (`meta.itemId`); Spotify removes by URI and has none. */
  entryId: string | null
  isrc: string | null
}

/** Each song a write could not apply, by the service's track ID, with the service's reason. */
export type WriteFailures = Map<string, string>

/**
 * Push's write path to one service (docs/decisions/0007): the only code that changes a real library, apart from
 * the Tidal playlist cleanup. Every write is idempotent: adding what is there or removing what is not succeeds.
 */
export interface PushWriter {
  readonly id: ProviderId
  /** A track this service offers in the account's country, per ISRC that has one. */
  findPlayableByIsrcs(isrcs: string[]): Promise<Map<string, string>>
  /** The playlist's entries now, or null when it no longer exists. */
  readPlaylist(playlistId: string): Promise<PlaylistEntry[] | null>
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<WriteFailures>
  removeFromPlaylist(playlistId: string, entries: PlaylistEntry[]): Promise<WriteFailures>
  addLiked(trackIds: string[]): Promise<WriteFailures>
  removeLiked(trackIds: string[]): Promise<WriteFailures>
}
