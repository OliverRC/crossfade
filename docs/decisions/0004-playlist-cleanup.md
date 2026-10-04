# 0004 Playlist cleanup on Tidal before M5

Date: 2026-10-03 · Milestone: V0

The first full fetch found 108 owned Tidal playlists with only 70 distinct names. Their descriptions show TuneMyMusic created them, so most look like an import that ran twice. Pairing joins one copy to the Spotify playlist of the same name; the other became a Tidal-only collection, which M5 would have turned into a duplicate on Spotify too.

Decision: a Cleanup page finds duplicate and empty playlists and, for Tidal only, merges exact copies and removes empty playlists. Oliver allowed this as the one exception to "no writes to the real library before M5".

Tiers, compared per service by ISRC (the service's own ID when there is no ISRC) among playlists whose names normalise the same:

| Tier | Rule | Action |
| --- | --- | --- |
| Exact copies | Items in every copy are at least 90% of the largest copy | Merge: keep one, delete the rest |
| One contains the other | Every copy has at least 90% of its items in the largest copy | Shown only |
| Same name, different tracks | Neither | Shown only |
| Empty | No items, whatever the name | Delete |

Overlap without a matching name is not a duplicate: the only such pair found was a 2-track playlist inside a 92-track one.

Safety, in order, per group:

1. Read every copy fresh from Tidal, without a country code so nothing region-unavailable is hidden. If the returned count differs from the playlist's `numberOfItems`, stop.
2. Re-check the names and the tier on the fresh data; skip the group if it is no longer exact copies.
3. Add what the kept copy lacks (`onDuplicates: SKIP`, `Idempotency-Key` per batch).
4. Read the kept copy back. Delete nothing unless it holds every playable song of every copy (see Pulled songs).
5. Save each spare (name, description, access type, items) in `playlist_backups`, then delete it.

## Pulled songs

The first real run stopped 4 of 20 merges: in each, the copy to delete held a song Tidal no longer offers (404 in every country). Tidal cannot add such a song to a playlist, so the strict guarantee could never be met. The sync had never seen these songs: reading tracks with a country code silently leaves them out.

Oliver's rule: the kept playlist is the combination of every playable song of every copy, and Crossfade remembers the pulled ones.

- Before adding, the songs to add are checked against Tidal's catalogue for the account's country. A pulled song whose ISRC is playable under another ID is added as that.
- The rest are saved in `unavailable_items` against the kept playlist, and the guarantee in step 4 covers every playable song.
- Re-adding a remembered song when it returns belongs with the scheduled re-check (plan, phase 2).

Afterwards the local state follows: the kept playlist's saved fetch gains the spares' tracks, the deleted playlists leave the saved fetches, and if a deleted copy was the one paired with Spotify, the kept copy takes over that pairing.

Each cleanup is an Activity entry ("Clean up Tidal", marked as having written to Tidal) with a line per playlist. In M5 a cleanup should become a change to main that Push to Tidal carries out, so playlist deletions go through push like every other write (0005).

Cleanup and sync share one lock (`server/jobs/lock.ts`); a scheduled resume that finds a cleanup running retries a minute later.

Not done: tiers 2 and 3, Spotify (it has no duplicates; Spotify deletes are unfollows), and restoring from a backup, which needs `createPlaylist` from M5.
