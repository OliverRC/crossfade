# Crossfade

Self-hosted two-way sync of one person's Spotify and Tidal libraries (liked songs and owned playlists), with a Sonarr-style side-by-side diff view. The full plan is `docs/plan.md`; the reference UI is `docs/direction-b.pdf`. Deviations from the plan are recorded in `docs/decisions/`.

## Status

- Current milestone: **M4 Main and pull** (`docs/decisions/0005`). Done when pulling Tidal then Spotify builds a main Oliver agrees with, the Library page shows what each service is missing, and pulling again with nothing changed reports nothing new. V0 is done; its dry-run sync was replaced by pull.
- In progress: M5 (push), in slices (`docs/decisions/0007`): staging and push to both services are built (push sends only staged changes; new changes start unstaged; Spotify lookups are capped per push by `SPOTIFY_LOOKUPS_PER_RUN`). Real pushes to both services ran on 2026-10-04; songs not found by ISRC stay staged for M3's manual search. Creating playlists on the other service is next. M3 (manual search and review) follows M5. A one-press sync (pull both, push both) waits until pull and push are trusted. Docker and Unraid packaging can slot in whenever he wants it deployed.
- Pulls are checkpointed and resumable, and pause on quota (`docs/decisions/0003`). Spotify's Development Mode quota is unpublished, with reported cooldowns of 13 to 18 hours: never retry `QUOTA_EXCEEDED`, and keep Spotify lookups rationed (they belong to push).
- Work one milestone at a time. Stop at each milestone's "Done when" for Oliver to verify.

## Commands

- `pnpm dev`: dev server on port 4050. Spotify rejects `localhost` redirect URIs, so the app is served from `127.0.0.1:4050`; requests to `localhost:4050` are redirected there (`server/middleware/0.canonical-host.ts`) so the login cookie and OAuth callback share a host.
- `pnpm test`: Vitest (core, crypto, cleanup, and an end-to-end pull against fake services).
- `pnpm typecheck`
- `pnpm db:generate --name <change>` after editing `server/db/schema.ts`. Migrations apply on server start.
- `pnpm hash-password '<password>'` prints `APP_PASSWORD_HASH`.

## Principles

- The git model (`docs/decisions/0005`): main is the canonical library; Spotify and Tidal are equal remotes. Pull reads one service and updates main, never writing to a service. Push is the only code path that writes to Spotify or Tidal, and it always shows its changes before writing.
- ISRC first, then exact metadata across services (`docs/decisions/0008`), before anything fuzzy. Fuzzy matches are proposed for review, never auto-linked in the MVP.
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
- No writes to the real library before M5, except to a dedicated test playlist on each service, and the Tidal playlist cleanup (`docs/decisions/0004`): merging exact duplicate copies and removing empty playlists, confirmed by Oliver on the Cleanup page.
- Test diff rules table-driven, one case per row of the plan's diff table. Test adapters against recorded HTTP fixtures.
- Secrets never go in the repo or image; keep `.env.example` current.
- All timestamps UTC.

## API facts verified 2026-10-02

Spotify:
- Saved tracks: read `GET /me/tracks`; write `PUT`/`DELETE /me/library?uris=…` (URIs in the query string, max 40).
- Playlist items: `/playlists/{id}/items` (old `/tracks` paths return 403). Item objects use `item` (was `track`). Remove body is `{ items: [{ uri }], snapshot_id? }`.
- Playlist items are readable only for playlists the user owns or collaborates on; others return 403 (`docs/decisions/0006`). `/me/playlists` lists followed ones too, with `owner` and `collaborative`.
- Create playlist: `POST /me/playlists`. Search `limit` max 10.
- `external_ids` (ISRC) was removed in Feb 2026 and restored in March 2026.
- No batch ISRC lookup (Get Several Tracks is gone). Search with `OR` between `isrc:` filters is undocumented; `server/providers/spotify-isrc.ts` detects whether it works and falls back to one ISRC per request.
- Development Mode quota: unpublished, shared across the developer account; `429` with `reason: QUOTA_EXCEEDED`, reported cooldowns of 13 to 18 hours. Observed 2026-10-03: `Retry-After: 84469` (about 23.5 hours).

Tidal (`https://openapi.tidal.com/v2`, JSON:API, `application/vnd.api+json`):
- Liked tracks: `/userCollectionTracks/me/relationships/items` (GET, POST, DELETE; body `{ data: [{ type: 'tracks', id }] }`, max 50 per write).
- Owned playlists: `GET /playlists?filter[owners.id]=me`. Favourited playlists: `/userCollectionPlaylists/me/relationships/items`.
- Playlist items: `/playlists/{id}/relationships/items`. Add accepts `meta.onDuplicates: SKIP` and reports songs it did not add in the response's `meta.skipped` (`NOT_FOUND` or `ALREADY_PRESENT`). Remove body is `{ data: [{ type, id, meta: { itemId } }] }`; GET returns each entry's `meta.itemId`. Max 50 per write. Checked against spec 1.10.148 on 2026-10-04.
- ISRC lookup: `GET /tracks?filter[isrc]=…`. Search: `/searchResults/{query}/relationships/tracks`.
- OAuth: `https://login.tidal.com/authorize`, token `https://auth.tidal.com/v1/oauth2/token`, PKCE.

## Layout

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
/scripts                   CLI helpers
```

## Visual design

Black ground, mint `#D4F5CF` (adds, in sync), coral `#FF4438` (queue, removals, failures), amber `#F2B84B` (review). Orbitron 900 for display only, Space Grotesk for UI, JetBrains Mono for ISRCs, scores and timestamps. 28 px card radius, 20 px row radius, pill tags and buttons. Every state carries a glyph as well as a colour. Full token table in `docs/plan.md`.
