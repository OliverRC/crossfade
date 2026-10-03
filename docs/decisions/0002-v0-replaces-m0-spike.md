# 0002 A Nuxt V0 replaces the M0 spike

Date: 2026-10-03 · Milestones: M0 to M2

The plan gated everything behind a throwaway console spike (M0). Oliver preferred to go straight to a Nuxt prototype: the same risks (Tidal user-scope approval, Spotify Development Mode, blocked endpoints) show up the moment he clicks Connect and runs the first dry run, and the first-run flow has to be built for the web app anyway.

Decision: V0 combines M1 and most of M2.

- In V0: app login, Connections page with PKCE sign-in for both services, encrypted tokens with refresh, read-only adapters, ISRC matching, basic fuzzy matching, playlist pairing by name, and a dry-run Sync that renders the Direction B diff.
- Not in V0: Docker and Unraid packaging (rest of M1), manual search and review (M3), snapshots and the editable queue (M4), and every write (M5). Apply is visible but disabled.
- The spike is deleted; its endpoint research lives in `CLAUDE.md` and the adapters. It remains in git history at `ede371b`.

Smaller deviations, recorded here so they are not lost:

- `MusicProvider.findByIsrc` became `findByIsrcs(isrcs[])`. Tidal resolves up to 20 ISRCs per call, which matters under its throttling.
- `TrackLink` gains status `review` with `candidateTrackId` and a display copy of the candidate. The plan models review as a `linkReview` pending action; until the queue exists (M4) the link row carries it.
- `TrackLink.method` gains `origin` for the provider track that created the canonical record.
- The V0 diff is a union merge (bootstrap semantics: never removes). It is stored as JSON on the `sync_runs` row and replaced by the persistent queue in M4.
- The app password hash is scrypt from `node:crypto` (`pnpm hash-password`) rather than `nuxt-auth-utils`' helper, which cannot run outside Nuxt.
- Sign-in uses PKCE without client secrets. The secret variables stay in `.env.example` for later.
