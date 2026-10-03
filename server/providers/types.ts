import type { ProviderId, ProviderPlaylist, ProviderTrack } from '../../shared/types'

/**
 * The only code that talks to Spotify or Tidal implements this.
 * V0 is read-only; the write methods from the plan (addLiked, removeLiked, addToPlaylist,
 * removeFromPlaylist, createPlaylist) arrive in M5.
 */
export interface MusicProvider {
  readonly id: ProviderId
  getLikedTracks(): Promise<ProviderTrack[]>
  getOwnedPlaylists(): Promise<ProviderPlaylist[]>
  getPlaylistTracks(playlistId: string): Promise<ProviderTrack[]>
  /** Batched: Tidal resolves up to 20 ISRCs per call. Each ISRC maps to every track found for it. */
  findByIsrcs(isrcs: string[]): Promise<Map<string, ProviderTrack[]>>
  search(query: string): Promise<ProviderTrack[]>
}
