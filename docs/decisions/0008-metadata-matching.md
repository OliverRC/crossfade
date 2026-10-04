# 0008 Metadata matching after ISRC

Date: 2026-10-04 · Milestone: M4 (brought forward from M3)

Pull joined songs across services by ISRC only. The same recording often carries a different ISRC on each service: a single and its album, a deluxe reissue, a label's re-release. In Alt Tunes, Spotify holds "Don't Say Anything" as `USEP41431013` and Tidal as `USEP41431030`, with the same title, artist, album and length. Main kept them as two songs, so the Library showed each service missing the other's copy, and a push would have added a second copy on both.

Oliver's call: matching starts on ISRC and falls back to metadata.

## Rule

Two songs are one song when all of these hold:

- The cleaned-up title base, artists and version are equal. Cleaning lowercases, strips accents and punctuation, turns `&` into `and`, moves "feat." artists into the artist list, and splits version tags ("Remastered", "Live", "Radio Edit") from the title. Tidal's separate version field counts as part of the title.
- Their lengths are within 2 seconds.
- Between them they are on both services. Two copies that only one service holds never merge: a service keeping two copies apart (a demo and a re-recording, clean and explicit) usually means they differ.
- The match is unambiguous: if one service has two candidate copies, neither joins.

Album is deliberately not part of the rule, so a single and its album release join. That is the main risk; the strict version and length checks are the guard.

The joined link has method `metadata`. It is an exact match, not a fuzzy one: fuzzy candidates are still proposed for review, never linked (M3).

## How

- `server/core/match.ts` decides which songs are one song (pure). Pull's link stage folds them after the ISRC pass, on every pull, so new songs and songs already in main are both caught. Folding moves the merged song's links, memberships, snapshot entries, staged picks and open conflicts onto the song that stays (the one on more services, then the oldest).
- A service holding two releases of the song now holds it twice in its snapshot, under each release's ID. Push removes every copy; status counts the song as available if either copy is.
- `canonical_tracks.version` keeps Tidal's version tag, which songs first seen on Tidal had lost. Migration 0011 backfills it from saved fetches (821 songs on 2026-10-04). Without it a Tidal live version or remix looked like the studio song.

On Oliver's library on 2026-10-04 this joined 17 songs: 3,274 to 3,255 songs waiting for Spotify and 78 to 63 for Tidal.

## Not yet

- Undoing a wrong join. Once M3 can unlink a song, the unlink must be stored so a later pull does not join it again.
- Picking which release each service should hold (a "move": replace the single with the album copy on a service). Pull now knows both releases are one song, which is what a move needs.
- An outside model scoring the fuzzy candidates in review, once M3 has a review list.
