# 0003 Checkpointed, resumable sync runs

Date: 2026-10-03 · Milestone: V0

The first real sync hit Spotify's `429 QUOTA_EXCEEDED` partway through matching, and the whole run was discarded. Spotify does not publish Development Mode quotas, and developers report cooldowns of 13 to 18 hours. A first sync between libraries of very different sizes (here about 6,500 Tidal tracks against 720 Spotify ones) needs thousands of Spotify lookups, because Spotify has no batch ISRC lookup.

Decision: a sync is a persistent run in stages (fetch, link, pair, match, diff) with checkpoints, and is complete only when every stage finishes.

- Playlist lists and each fetched collection are saved in `sync_runs.playlists` and `fetch_checkpoints`. Match results are saved per track, as before, in batches of one request's worth (Spotify 1 ISRC, Tidal 20).
- `QuotaError` (Spotify `QUOTA_EXCEEDED`, or any 429 asking for more than 60 seconds) is never retried. The service is paused until `Retry-After`, or for 6 hours when no time is given. The run becomes `paused` while the other service's work continues.
- Spotify lookups are rationed per run (`SPOTIFY_LOOKUPS_PER_RUN`, default 150). A spent budget pauses the run for 30 minutes.
- A paused run saves a provisional diff, with lookups not done yet shown as `pending`, and schedules its own resume. The schedule is restored after a server restart. Sync only plans, so resuming automatically never writes.
- Pressing Sync resumes the latest unfinished run if it started within 3 days; otherwise a fresh run starts.
- Requests per provider are counted across resumes in `sync_runs.counts` so the real quota can be learned.

Trade-off: a resumed run uses collections fetched hours earlier. That is acceptable for a plan; Apply re-fetches fresh state before writing (plan, "Apply" step 3).

## Follow-up: fewer requests

- Fuzzy search against the target service is off in V0 (`SyncOptions.fuzzySearch`). An ISRC miss is recorded as `no_isrc_match`, so a later fuzzy pass or M3's manual search can target exactly those tracks. Comparing against the other library in memory stays on, because it is free.
- Every lookup that can be batched is batched: Tidal resolves 20 ISRCs and 20 track IDs per request, and Spotify pages are fetched 50 at a time, the maximum.
- Spotify has no batch ISRC endpoint, only search. `server/providers/spotify-isrc.ts` tries `isrc:A OR isrc:B …` five at a time and learns per process whether Spotify honours `OR`: it confirms when a batch returns two requested ISRCs, and rejects it when a single lookup finds a track that an unsaturated batch missed. Results are always checked against the requested ISRC, so a wrong guess costs requests but never makes a wrong link.
- The run budget charges each lookup's actual request count.
