# 0001 Tidal endpoints differ from the plan's table

Date: 2026-10-02 · Milestone: M0

The plan's adapter table used `/userCollections/{id}/relationships/tracks` and `/relationships/playlists`. The current Tidal OpenAPI spec (v1.10.147) has no `/userCollections` path. It splits the collection by type instead.

| Operation | Plan | Spec |
| --- | --- | --- |
| Liked tracks (read, add, remove) | `/userCollections/{id}/relationships/tracks` | `/userCollectionTracks/me/relationships/items` |
| Owned playlists | `/userCollections/{id}/relationships/playlists` | `GET /playlists?filter[owners.id]=me` |
| Favourited playlists | not covered | `/userCollectionPlaylists/me/relationships/items` |
| Remove from playlist | track IDs | each entry needs `meta.itemId` (the playlist entry ID), so the adapter must read entries before removing |

Decision: the adapter follows the spec. If `filter[owners.id]=me` returns exactly the user's own playlists, that answers the plan's open question about owned versus favourited playlists. The M0 spike confirms this.

Consequence: `MusicProvider.removeFromPlaylist` keeps taking track IDs. The Tidal adapter resolves them to entry IDs from fresh playlist state. Apply already fetches fresh state before writing, so this costs nothing extra.
