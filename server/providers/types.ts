import type { ProviderId, ProviderPlaylist, ProviderTrack } from '../../shared/types'
import type { IsrcLookup } from './spotify-isrc'

/**
 * The only code that talks to Spotify or Tidal implements this.
 * V0 is read-only; the write methods from the plan (addLiked, removeLiked, addToPlaylist,
 * removeFromPlaylist, createPlaylist) arrive in M5.
 */
export interface MusicProvider {
  readonly id: ProviderId
  /** ISRCs handed to one findByIsrcs call (Spotify 5, Tidal 20): a quota error loses at most one call's results. */
  readonly isrcBatchSize: number
  /** Liked and playlist reads include songs the service still lists but no longer offers, with `available: false`. */
  getLikedTracks(): Promise<ProviderTrack[]>
  getOwnedPlaylists(): Promise<ProviderPlaylist[]>
  getPlaylistTracks(playlistId: string): Promise<ProviderTrack[]>
  /** Each ISRC maps to every track found for it; `requests` is what the lookup cost. */
  findByIsrcs(isrcs: string[]): Promise<IsrcLookup>
  search(query: string): Promise<ProviderTrack[]>
  /** How lookups are being made, when that was learned at runtime (Spotify's OR support). */
  lookupMode?(): string | null
}
