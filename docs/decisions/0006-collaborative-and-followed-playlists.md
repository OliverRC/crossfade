# 0006 Collaborative and followed playlists

Date: 2026-10-04 · Milestone: M4

The plan keeps owned playlists only and lists playlists owned by other people as a non-goal. The first Spotify pull showed the cost: Oliver's Tidal library holds his own copies of playlists that are Niki's on Spotify ("💓 Oli and Nix 💓 Bali 💓", "Melodic Drum and Bass 2025", "The Dunes"). Spotify dropped them as not his, so the Library showed every song in them as missing on Spotify, and M5 would have pushed duplicates into his Spotify.

Spotify only returns the songs of playlists the user owns or collaborates on; any other playlist's `/playlists/{id}/items` returns 403 (February 2026 changelog). So other people's playlists split in two:

| Kind | Spotify `/me/playlists` | Crossfade |
| --- | --- | --- |
| Owned | `owner.id` is the user | Read, paired, pushed, as before |
| Collaborative | someone else's, `collaborative: true` | Read, paired and pushed like an owned playlist. Pushes edit the other person's playlist too |
| Followed | someone else's, not collaborative | Listed and paired by name, never read or pushed |

## Rules

- `collection_links.access` records owned, collaborative or followed, with the owner's display name (replaces the unused `is_owned`).
- A followed playlist gets no snapshot. Its side of each row is `followed`: not missing, nothing to push, and the row's state comes from the other service.
- A collaborative playlist that answers 403 anyway is treated as followed for that pull, with a warning in the run log, rather than failing the pull.
- A followed playlist the service stops listing loses its link, and its collection goes too if nothing else holds it. It is not held as gone, since nothing was ever read from it.
- Pairing by name prefers a same-named collection the service is not on yet, so a second copy on one service does not block pairing.
- The Library page groups collections as Mine, Collab and Followed. A collection is Collab or Followed if it is someone else's on any service, so Oliver's Tidal copy of Niki's playlist sits with it.

Tidal is unchanged: it lists owned playlists only. Tidal collaborative playlists (`filter[collaborators.id]=me`) are not read yet.
