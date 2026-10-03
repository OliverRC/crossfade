# Crossfade

Self-hosted two-way sync of one person's Spotify and Tidal libraries (liked songs and owned playlists), with a Sonarr-style side-by-side diff view. The full plan is `docs/plan.md`; the reference UI is `docs/direction-b.pdf`. Deviations from the plan are recorded in `docs/decisions/`.

## Status

- Current milestone: **M0 API spike** (`spike/`). No app code until M0's "Done when" is met and Oliver has verified it.
- Work one milestone at a time. Stop at each milestone's "Done when" for Oliver to verify.

## Principles

- Sync only plans. Every change lands in a persistent queue; Apply is the only code path that writes to Spotify or Tidal.
- ISRC before anything fuzzy. Fuzzy matches are proposed for review, never auto-linked in the MVP.
- Human decisions (manual links, ignores, dequeues) are stored and never re-litigated.
- Failures and unmatched tracks are states on the item and clear themselves when resolved.
- Simple over clever: full snapshots, in-memory diffing, one SQLite file, one container.

## Stack

Nuxt (Vue 3, TypeScript) with Nitro server routes, SQLite via Drizzle, `nuxt-auth-utils` for the single-user login, Node `crypto` AES-256-GCM for tokens at rest, SSE via h3 for progress, Vitest, one Docker image on Unraid behind Cloudflare Access. Node 24 (`.nvmrc`), pnpm.

Ask before adding dependencies outside this stack.

## Rules

- Treat API knowledge from training data as stale. Check Spotify calls against the February and March 2026 changelogs, and Tidal calls against the published OpenAPI spec (`https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json`).
- Thin typed clients per provider on `ofetch`; no third-party Spotify SDKs unless confirmed to use `/items` and `/me/library`.
- Adapters are the only code that talks to Spotify or Tidal. `server/core` (matching, diff, planning) is pure functions over snapshots: no I/O.
- No writes to the real library before M5, except to a dedicated test playlist on each service.
- Test diff rules table-driven, one case per row of the plan's diff table. Test adapters against recorded HTTP fixtures.
- Secrets never go in the repo or image; keep `.env.example` current.
- All timestamps UTC.

## API facts verified 2026-10-02

Spotify:
- Saved tracks: read `GET /me/tracks`; write `PUT`/`DELETE /me/library?uris=…` (URIs in the query string, max 40).
- Playlist items: `/playlists/{id}/items` (old `/tracks` paths return 403). Item objects use `item` (was `track`). Remove body is `{ items: [{ uri }], snapshot_id? }`.
- Create playlist: `POST /me/playlists`. Search `limit` max 10.
- `external_ids` (ISRC) was removed in Feb 2026 and restored in March 2026.

Tidal (`https://openapi.tidal.com/v2`, JSON:API, `application/vnd.api+json`):
- Liked tracks: `/userCollectionTracks/me/relationships/items` (GET, POST, DELETE; max 50 per write).
- Owned playlists: `GET /playlists?filter[owners.id]=me`. Favourited playlists: `/userCollectionPlaylists/me/relationships/items`.
- Playlist items: `/playlists/{id}/relationships/items`. Add accepts `meta.onDuplicates: SKIP`. Remove needs each entry's `meta.itemId`, not only the track ID.
- ISRC lookup: `GET /tracks?filter[isrc]=…`. Search: `/searchResults/{query}/relationships/tracks`.
- OAuth: `https://login.tidal.com/authorize`, token `https://auth.tidal.com/v1/oauth2/token`, PKCE.

## Layout (from M1)

```
/app                       Nuxt pages, components, composables
/server/api                API routes
/server/routes/auth        OAuth start and callback routes
/server/core               matching, diff, planning (pure, no I/O)
/server/providers/spotify  Spotify adapter
/server/providers/tidal    Tidal adapter
/server/db                 Drizzle schema and migrations
/server/jobs               sync runner, run lock, scheduler (phase 2)
/shared/types              types shared by UI and server
/tests                     Vitest unit and fixture-based adapter tests
/deploy                    Dockerfile, Unraid template
/docs/decisions            decision notes
/spike                     M0 throwaway API spike
```

## Visual design

Black ground, mint `#D4F5CF` (adds, in sync), coral `#FF4438` (queue, removals, failures), amber `#F2B84B` (review). Orbitron 900 for display only, Space Grotesk for UI, JetBrains Mono for ISRCs, scores and timestamps. 28 px card radius, 20 px row radius, pill tags and buttons. Every state carries a glyph as well as a colour. Full token table in `docs/plan.md`.
