# Crossfade — Claude Code Handoff Plan

Oct 1, 2026 · @Oliver and Niki

## Overview

Build Crossfade, a self-hosted web app that keeps a personal Spotify library and Tidal library in sync both ways, through a side-by-side diff view in the spirit of Sonarr and Radarr. Neither service is the master: the app owns its own canonical library, and Spotify and Tidal are two equal primaries it reads from and writes to.

The library is small (hundreds to low thousands of tracks), so correctness and transparency matter far more than performance. Existing SaaS tools behave like one-off migrations; this tool is built for ongoing sync.

Guiding principles:

- Never surprise the user: Sync only plans. Every change lands in a queue, and nothing is written until the user applies it.
- Hard-match first: ISRC before anything fuzzy, because a wrong link is worse than a missing one.
- Remember human decisions: a confirmed or overridden match is stored and never re-litigated.
- State, not events: failures and unmatched tracks are states on the item, and they clear themselves once resolved.
- Simple over clever: full snapshots, in-memory diffing, one SQLite file, one container.

## Scope

The MVP keeps liked songs and owned playlists in step between Spotify and Tidal: Sync builds a queue of changes, the user edits it, and Apply writes what is left queued.

MVP:

- Liked songs (Spotify Saved Tracks, Tidal collection tracks), synced as a set.
- Playlists the user owns on either side, synced as sets of tracks; ordering is ignored. A playlist that exists on one side only can be created on the other.
- One-time bootstrap reconciliation that seeds the canonical store from current state.
- Automatic ISRC matching, fuzzy fallback with a confidence score, and a manual search override.
- Unmatched tracks recorded with a reason, not dropped.
- Per-item failure state that clears on a successful retry.
- A Sync button that only plans, a queue the user can edit item by item, and an Apply button that writes what is queued.

Phase 2:

- Scheduled sync that refreshes the queue on a timer; it still never writes. Auto-applying ISRC-matched adds could be a later opt-in.
- Periodic re-check of unmatched tracks, surfacing newly available ones as pending actions.

Stretch:

- Followed artists and saved albums, using the same canonical-entity pattern (albums matched by UPC).

Non-goals:

- Play counts and listening history.
- Playlist ordering.
- Playlists owned by other people (followed or editorial).
- Multiple users. The adapter interface should still allow a third service later.

## Architecture and stack

One Nuxt app in one container holds the Vue UI, Nitro server routes, a pure TypeScript sync core, two provider adapters and a SQLite canonical store.

&#91;embedded content: architecture · one container, two adapters, one canonical store\]

Adapters are the only code that talks to Spotify or Tidal. The engine works on snapshots and writes its plan to the store, so it can be tested without any network. A sync runs in-process behind a lock, never inside a request handler, and the UI follows it over server-sent events.

| Layer | Choice | Why |
| --- | --- | --- |
| App framework | Nuxt (Vue 3, TypeScript), Nitro server routes for the API | Oliver's recent stack; UI and API in one project with shared types |
| Storage | SQLite via Drizzle ORM and its migrations | One file; a few thousand tracks fit easily |
| App login | `nuxt-auth-utils` sealed cookie session | Fits a single username and password |
| Token encryption | Node `crypto`, AES-256-GCM, key from an env var | Built in |
| Background work | In-process runner with a lock; Nitro scheduled tasks or a small cron library in phase 2 | No external queue needed |
| Live progress | Server-sent events via h3 | One-way, simpler than WebSockets |
| Tests | Vitest | Native to the Vite toolchain |
| Packaging | One Docker image running the Nitro build on Node LTS | Unraid-native |

.NET was the alternative. Both are familiar, but Nuxt covers UI and API in one language with shared types, so the familiar stack wins.

## Data model

The canonical store holds one record per real-world track and playlist, with provider IDs hanging off it, plus a per-provider snapshot that acts as the baseline for the next diff.

| Entity | Purpose | Key fields |
| --- | --- | --- |
| CanonicalTrack | One real recording | id, isrc, title, artists, album, durationMs, createdAt |
| TrackLink | A provider's copy of a canonical track | canonicalTrackId, provider, providerTrackId (null when unmatched), status (matched / unmatched / ignored), method (isrc / fuzzy / manual), confidence, unmatchedReason, isPreferred, lastCheckedAt |
| Collection | Liked songs, or one playlist | id, kind (liked / playlist), name |
| CollectionLink | A provider's copy of a collection | collectionId, provider, providerCollectionId (null for liked), isOwned |
| Membership | Canonical "this track belongs here" | collectionId, canonicalTrackId, state (active / removed), changedAt, changedBy (sync / user) |
| Snapshot | Last-synced state of one collection on one provider | provider, collectionId, takenAt, providerTrackIds (set) |
| PendingAction | One change in the queue | id, syncRunId, collectionId, canonicalTrackId, provider, kind (add / remove / createPlaylist / linkReview), status (queued / dequeued / running / succeeded / failed / obsolete), userSet (true when the user queued or dequeued it), attempts, lastError, lastAttemptAt |
| SyncRun | One sync (plan) or one apply | id, kind (sync / apply), trigger (manual / schedule), startedAt, finishedAt, counts |
| ProviderAccount | OAuth tokens for one service | provider, providerUserId, accessToken and refreshToken (encrypted), expiresAt, scopes |

Rules the schema must enforce:

- (provider, providerTrackId) is unique: a provider track maps to exactly one canonical track.
- A canonical track may have several provider IDs on one service (the same recording on two albums); one is marked isPreferred and used for writes.
- Unmatched tracks keep a TrackLink row with a null providerTrackId, so "seen on Spotify, not on Tidal" is queryable.
- Removed memberships are kept as tombstones, so a stale snapshot can never silently re-add a deliberately removed track.
- All timestamps in UTC.

## Auth and provider adapters

Both services allow a personal app to read and write a user's library over OAuth, but Spotify reshaped its API in February 2026, so code must target the new endpoints rather than older SDKs or examples.

### App login

- One username and a password hash, both from environment variables. No user table, no reset flow.
- Sealed cookie session via `nuxt-auth-utils` (HttpOnly, Secure, SameSite=Lax). The whole app also sits behind Cloudflare Access.

### Provider connections

- A Connections page with Connect Spotify and Connect Tidal buttons, using Authorization Code with PKCE for both.
- Callbacks at `https://<host>/auth/spotify/callback` and `https://<host>/auth/tidal/callback`, left reachable through Cloudflare Access.
- Tokens encrypted at rest with AES-256-GCM (Node `crypto`), key from `TOKEN_ENCRYPTION_KEY`.
- Refresh before expiry. If a refresh fails, mark the account "needs reconnect", show a banner, and skip that side's writes.

### Spotify specifics

- Development Mode is enough for one user: the app owner needs Premium, and each app allows up to 5 allowlisted users ([Spotify announcement](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)).
- Quota is shared per developer account; a 429 carrying reason `QUOTA_EXCEEDED` means quota, anything else is a rate limit. Honour `Retry-After` either way ([quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)).
- Scopes: `user-library-read`, `user-library-modify`, `playlist-read-private`, `playlist-modify-private`, `playlist-modify-public`.
- Saved-track writes moved to `PUT` and `DELETE /me/library`, which take Spotify URIs. Playlist item endpoints moved from `/tracks` to `/items`; the old paths return 403 ([changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026), [SDK issue](https://github.com/spotify/spotify-web-api-ts-sdk/issues/159)).
- Get Several Tracks is gone and search returns at most 10 results. Saved-track and playlist responses already include full track objects with `external_ids.isrc`, so no extra lookups are needed.
- Playlist contents are only returned for the user's own playlists, which matches the owned-only scope.

### Tidal specifics

- Open API at `openapi.tidal.com/v2`: JSON:API, OAuth with PKCE, scopes `collection.read`, `collection.write`, `playlists.read`, `playlists.write`, `search.read`, `user.read` ([provider overview](https://apis.io/providers/tidal/)).
- Responses page at a fixed 20 items with a cursor, and developers report tight throttling. Serialise calls and back off on 429.
- Most calls need a `countryCode`; take it from the user's profile.
- Generate the client from Tidal's published OpenAPI spec ([reference](https://tidal-music.github.io/tidal-api-reference/)), not from memory: paths have changed over time.

### Operations each adapter must support

| Operation | Spotify | Tidal (v2) |
| --- | --- | --- |
| Read liked tracks | `GET /me/tracks` | `GET /userCollections/{id}/relationships/tracks` |
| Add liked tracks | `PUT /me/library` | `POST /userCollections/{id}/relationships/tracks` |
| Remove liked tracks | `DELETE /me/library` | `DELETE /userCollections/{id}/relationships/tracks` |
| List playlists | `GET /me/playlists`, keep owner = me | `GET /userCollections/{id}/relationships/playlists` (confirm it separates owned from favourited) |
| Read playlist tracks | `GET /playlists/{id}/items` | `GET /playlists/{id}/relationships/items` |
| Add to playlist | `POST /playlists/{id}/items` | `POST /playlists/{id}/relationships/items` |
| Remove from playlist | `DELETE /playlists/{id}/items` | `DELETE /playlists/{id}/relationships/items` |
| Create playlist | `POST /me/playlists` | `POST /playlists` |
| Look up by ISRC | `GET /search?q=isrc:{isrc}&type=track` | `GET /tracks?filter[isrc]={isrc}` |
| Free-text search | `GET /search` (max 10 results) | search results endpoint per the spec |

Adapter interface, so a third service can be added later:

```ts
export interface MusicProvider {
  readonly id: ProviderId
  getLikedTracks(): Promise<ProviderTrack[]>
  getOwnedPlaylists(): Promise<ProviderPlaylist[]>
  getPlaylistTracks(playlistId: string): Promise<ProviderTrack[]>
  addLiked(trackIds: string[]): Promise<WriteResult>
  removeLiked(trackIds: string[]): Promise<WriteResult>
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<WriteResult>
  removeFromPlaylist(playlistId: string, trackIds: string[]): Promise<WriteResult>
  createPlaylist(name: string): Promise<string>
  findByIsrc(isrc: string): Promise<ProviderTrack[]>
  search(query: string): Promise<ProviderTrack[]>
}

export interface ProviderTrack {
  providerTrackId: string
  isrc: string | null
  title: string
  artists: string[]
  album: string
  durationMs: number
  explicit: boolean
  version: string | null
}

// WriteResult: per-item success or failure with the provider's error, never all-or-nothing
```

## Matching engine

ISRC matches link automatically; everything else is proposed for human review in the MVP, because a wrong link is worse than a missing one.

For each source track that needs a counterpart on the other service:

1. Existing link: if a TrackLink exists, use it. Links with method `manual` are never re-evaluated.
2. ISRC lookup on the target service.
   - One result: link with method `isrc`, confidence 1.0.
   - Several results (same recording on different releases): prefer the same album title, then the same explicit flag, then the closest duration. Any of them is the same recording, so the pick is cosmetic.
   - No result, or no ISRC on the source: go to step 3.
3. Fuzzy search on the target with a normalised "artist title" query, scoring each candidate.
   - Best score at or above the review floor: create a `linkReview` pending action with the top candidate pre-selected. Never auto-link in the MVP.
   - Nothing at or above the floor: record the track as unmatched.
4. Unmatched: keep a TrackLink with a null provider ID and a reason: `not_found` (ISRC and search both empty), `low_confidence` (candidates, none good enough), or `ignored` (user said don't sync this one).

Region locking can't be told apart from absence reliably, since Spotify no longer returns available markets, so it is not a separate reason.

### Normalisation

- Lowercase, Unicode-normalise, and strip diacritics.
- Pull bracketed or dashed version tags ("Remastered 2011", "Live", "Radio Edit", "Acoustic") into a separate version field.
- Remove "feat." and "ft." segments from titles; compare featured artists separately.
- Replace "&" with "and", collapse punctuation and whitespace.

### Scoring (starting values, to tune against real data)

```latex
score = 0.45 \cdot title + 0.35 \cdot artist + 0.20 \cdot duration
```

- Title and artist: token-set similarity (0 to 1) on normalised strings.
- Duration: 1.0 within 2 seconds, falling linearly to 0 at 10 seconds apart.
- A version-tag mismatch (live vs studio, remix vs original) caps the score below the review floor.
- An explicit-flag mismatch subtracts 0.05.
- Review floor 0.60. A later setting can auto-accept above a higher threshold (off by default).

### Manual search (Sonarr-style)

- Open from any unmatched or review item.
- Shows the source track, an editable pre-filled query, and candidates with title, artists, album, duration, explicit flag, version, and the score breakdown.
- Actions: Link (method `manual`, confidence 1.0), Ignore, or search again. Spotify returns at most 10 results per query, so page with an offset.

### Unmatched re-check (phase 2)

A scheduled job re-runs steps 2 and 3 for unmatched tracks not checked in the last 7 days. A new ISRC hit links and queues an add; a new fuzzy hit queues a review.

### Tests

Keep a fixture set of tricky pairs as unit tests: remasters, featured artists, live versions, non-Latin titles, and identical titles by different artists.

## Sync engine

Each side is diffed against its own last snapshot, which turns "present on one side only" into a clear intent: added here, or removed there. Sync only ever plans; Apply is the only path that writes. One planning routine serves the button and, later, the scheduler.

### Bootstrap (first run only)

1. Both accounts connected; pull liked tracks and owned playlists from both sides in full.
2. Pair playlists by normalised name. Unpaired playlists are shown so the user can pair them by hand, create them on the other side, or exclude them.
3. Run every track through the matching engine.
4. Canonical membership for each collection = the union of both sides. Bootstrap never removes anything.
5. Queue the plan (adds per side, reviews needed, unmatched) for the user to edit.
6. On Apply, execute the queue, then write snapshots for both sides. These become the first baseline.

### Sync (plans only)

1. Take the run lock; if a sync or apply is running, skip. Create a run record (kind sync).
2. Refresh tokens. A side that needs reconnecting is shown as stale.
3. Fetch the full current state of both sides.
4. Sanity guard: if a collection comes back empty while its snapshot was not, or would lose more than 10% of its tracks (minimum 5), stop that collection and flag it. A failed or partial fetch must never look like a mass deletion.
5. Detect new playlists on either side and queue creating them on the other.
6. Send any track not yet linked through matching.
7. Diff each collection per canonical track (table below) and update the queue: new differences arrive queued, and failed items from the last apply come back queued.
8. Stop. Nothing is written.

The queue is persistent state, not a by-product of one sync. An item stays until its condition no longer holds (for example, the track is now on both sides), at which point it is marked obsolete. A choice the user made (userSet) survives every later sync while the difference is unchanged, so a dequeued item stays dequeued rather than reappearing as queued. Snapshots only detect new changes; the queue remembers the outstanding ones.

### Apply

1. Take the run lock and create a run record (kind apply).
2. Show a confirmation with the number of queued writes per service, listing removals separately.
3. For each affected collection, fetch fresh state and mark items no longer needed (already added or already removed) as obsolete.
4. Execute the remaining queued items in batches per provider and collection, recording a per-item result.
5. Update membership and snapshots from what actually succeeded. Dequeued items are left alone for next time.

### Diff rules for one track in one collection

| Spotify (snapshot → now) | Tidal (snapshot → now) | Meaning | Action |
| --- | --- | --- | --- |
| absent → present | absent → absent | Added on Spotify | Add on Tidal if matched, else record as unmatched |
| absent → absent | absent → present | Added on Tidal | Add on Spotify if matched, else record as unmatched |
| present → absent | present → present | Removed on Spotify | Remove on Tidal; membership becomes removed |
| present → present | present → absent | Removed on Tidal | Remove on Spotify; membership becomes removed |
| absent → present | absent → present | Added on both | Link if needed; no write |
| present → absent | present → absent | Removed on both | Membership becomes removed; no write |
| removed on one side | added on the other | Conflict | Ask the user; no automatic write |
| present, unchanged | absent, now matchable | Newly available | Add on Tidal (same rule in reverse) |

### Writes and failures

- Removals are queued like any other change; the Apply confirmation lists them separately so they are always seen before writing.
- Before adding to a playlist, check the freshly fetched state: Spotify playlists accept duplicates, so a blind add creates them.
- Within a run, retry 429 and 5xx responses up to 3 times with backoff, honouring `Retry-After`.
- A write that still fails keeps status `failed` with `lastError`, and stays in the queue, so the next Apply retries it.
- A successful retry clears the failure; nothing stale stays in the UI.
- Already-present on add, or already-absent on remove, counts as success.

## UI

The main screen is a diff tool: Spotify on the left, Tidal on the right, one aligned row per canonical track, and a queue column showing what will happen and what failed.

### Global header

- Sync button (plans only), Apply button showing the queued count, and the last sync and apply times.
- Live progress during a run via server-sent events.

### Library diff (home)

- Sidebar: Liked songs, then each playlist, each with badges for pending, failed, review and unmatched counts.
- Main pane: rows aligned by canonical track. Each side shows its copy or a gap. Default filter is "differences only"; a toggle shows everything.
- Row states: in sync, add to Tidal, add to Spotify, remove, review needed, unmatched, failed, conflict.
- Third column: the queued change for that row with a queue/dequeue toggle, its status, and "find match" (opens manual search). Bulk queue and dequeue per collection and per change type.
- Collection actions: Merge (union, the default), Mirror Spotify → Tidal, Mirror Tidal → Spotify. Mirror queues the removals it implies, like any other change.

### Other screens

- Queue: every queued, dequeued and failed change across collections, with queue all, dequeue all, and Apply. Failed rows show the last error and attempt count.
- Review queue: fuzzy candidates awaiting a decision, using the manual search panel.
- Unmatched: tracks with no counterpart, their reason and last check time, plus "check again".
- Runs: history of sync runs with trigger, dry-run flag and counts; open one to see its actions.
- Connections and settings: connect or reconnect each service, excluded playlists, matching thresholds, and (phase 2) the schedule.

### Visual design

Black, mint and coral: big rounded cards, pill tags and buttons, heavy techno display type, and a dot-matrix equalizer motif. The reference screen is "Direction B" on the [library diff canvas](https://claude.ai/artifact/PXB32ZqE84YvMas9J9UkvP); the other artboard there is a superseded direction.

| Token | Value | Use |
| --- | --- | --- |
| ground | `#000000` | Page background |
| surface | `#111111` | Diff table card, secondary cards |
| raised | `#1A1A1A` | Selected collection |
| hairline | `#333333`, `#444444` | Pill outlines, dashed empty cells |
| text | `#F2F2F2` | Primary text on black |
| text-muted | `#A3A3A3`, `#8C8C8C` | Labels and metadata |
| mint | `#D4F5CF` | Collection hero card, adds, in sync, primary pills; black text on it |
| coral | `#FF4438` | Queue and Apply card, removals, failures; black text on it |
| amber | `#F2B84B` | Review needed |
| Spotify badge | `#1ED760` | Small dot on the Spotify column only |
| Tidal badge | `#FFFFFF` | Small dot on the Tidal column only |

- Type: Orbitron (900) for display only: logo, collection title, queue count. Space Grotesk for UI text and track titles. JetBrains Mono for ISRCs, scores and timestamps.
- Shapes: 28 px radius cards, 20 px radius rows, fully rounded pills for tags, buttons and collection links.
- Row states are filled circle badges with a glyph: mint +, coral −, amber ?, coral ! on black for failed, grey outline ∅ for unmatched. A dequeued change shows an outline badge and a grey Dequeued pill.
- Equalizer: a 7-row dot matrix with off dots at 12 to 16% opacity. Use it on the queue card as the brand motif, and on the runs card where each column is one run's change count. Nowhere else.
- Motion: during a sync the equalizer columns animate and rows settle as they resolve. Respect reduced-motion.
- Accessibility: black text on mint and coral (both above 4.5:1), 44 px touch targets, and every state carries a glyph as well as a colour.

## Deployment

One Docker container on Unraid, reached through the existing Cloudflare tunnel and protected by Cloudflare Access.

### Container

- Multi-stage Dockerfile: build the Nuxt app, copy the `.output` folder into a slim Node LTS image, and run `node .output/server/index.mjs`.
- Runs as a non-root user on port 8080, honouring `PUID` and `PGID` (Unraid defaults 99 and 100).
- One volume, `/config`, mapped to `/mnt/user/appdata/<app>`: the SQLite database and logs.
- `/health` endpoint and a Docker `HEALTHCHECK`.
- Image built by GitHub Actions and pushed to GHCR, plus an Unraid template XML for one-click install.

### Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | e.g. `https://crossfade.<your-domain>`; used to build OAuth redirect URIs |
| `APP_USERNAME`, `APP_PASSWORD_HASH` | App login |
| `NUXT_SESSION_PASSWORD` | Seals the session cookie (at least 32 characters) |
| `TOKEN_ENCRYPTION_KEY` | Encrypts provider tokens at rest |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify app credentials |
| `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET` | Tidal app credentials |
| `TZ`, `PUID`, `PGID` | Unraid conventions |

Secrets never go in the image or the repo. A `.env.example` documents them.

### Cloudflare

- Add a public hostname on the tunnel pointing at the container, and an Access application covering the whole hostname.
- No bypass rule is needed for the OAuth callbacks: the provider redirects the user's own browser, which already holds the Access session.
- Register the exact callback URLs in both developer dashboards.

### Operations

- Logs: structured logging to console and a rolling file under `/config/logs`.
- Backups: a nightly `VACUUM INTO` copy of the database, keeping the last 7, alongside Unraid's own appdata backup.

## Milestones

Build in eight steps; M0 to M5 make the MVP, and nothing writes to a real library until M5.

### M0: API spike (gate)

- [ ] Register a Spotify app (Development Mode) and a Tidal app; set the callback URLs.
- [ ] Throwaway console app: OAuth to both, read liked tracks and one playlist, add and remove one track on a test playlist, ISRC lookup on each side.

Done when: every operation in the adapter table works against the real accounts, and it is known how Tidal separates owned from favourited playlists. If a write is blocked, stop and revisit the plan.

### M1: Skeleton and auth

- [ ] Nuxt project layout, SQLite with Drizzle migrations, app login.
- [ ] Connections page with both OAuth flows, encrypted token storage, background refresh.
- [ ] Dockerfile, deployed on Unraid behind Cloudflare Access.

Done when: login works at the public URL, both services show Connected, and tokens survive a container restart.

### M2: Read-only diff and matching

- [ ] Read side of both adapters, normalisation, ISRC matching, fuzzy scoring with fixture tests.
- [ ] Playlist pairing and the library diff screen. No writes of any kind.

Done when: every collection renders with correct matched, review and unmatched states, and fixture tests pass.

### M3: Manual search and review

- [ ] Manual search panel, review queue, ignore, unmatched screen.

Done when: any review item can be linked or ignored in under three clicks, and the decision survives the next run.

### M4: Sync and queue

- [ ] Snapshots, three-way diff, persistent queue with queue and dequeue, sanity guard, bootstrap plan.

Done when: a sync on the real library produces a queue Oliver agrees with, line by line, and a dequeued item stays dequeued after the next sync.

### M5: Writes (MVP complete)

- [ ] Apply with the fresh-state check, per-item results, retries, and failure state.
- [ ] Apply the bootstrap for real.

Done when: a track added on one side appears on the other after Sync; a removal propagates after Apply; a forced failure shows, then clears on retry.

### M6: Automation (phase 2)

- [ ] Scheduled sync (plans only) through the same routine, unmatched re-check, optional fuzzy auto-accept threshold.

### M7: Artists and albums (stretch)

- [ ] Followed artists and saved albums as new canonical entities, albums matched by UPC.

## Risks and open questions

The biggest risk is platform policy, not code: Spotify cut Development Mode back once in 2026 and could again, which is why M0 is a gate.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Spotify tightens Development Mode further | Writes stop working | Adapters isolated behind one interface; watch the Web API changelog; the store stays useful read-only |
| Spotify refresh tokens reportedly expire after six months ([tracker](https://vorplabs.com/agent-tools/spotify-api-changes); unverified) | Sync quietly stops | Treat refresh failure as "needs reconnect" with a visible banner; confirm in M0 |
| Tidal app not cleared for user scopes; some developers report an approval wait ([discussion](https://github.com/orgs/tidal-music/discussions/321)) | Tidal OAuth fails | Found in M0 before any real code |
| Tidal throttling and 20-item pages | Slow bootstrap | Serialised calls, backoff, progress UI; the library is small |
| Failed or partial fetch looks like deletions | Tracks removed on both sides | Sanity guard; Sync never writes; removals listed separately at Apply |
| Wrong fuzzy match | Wrong song added on the other side | No fuzzy auto-link in the MVP; links can be undone from the review screen |
| Spotify playlists allow duplicates | Repeated adds | Check fresh state before every add |

Open questions:

- [ ] Should playlist renames on one side propagate to the other?
- [ ] Should a new playlist on one side be proposed automatically, or only when opted in?
- [ ] How does Tidal's API separate owned from favourited playlists? (answered in M0)

## Working instructions for Claude Code

Work one milestone at a time and stop at each "Done when" for Oliver to verify before moving on.

- Treat API knowledge from training data as stale. Check every Spotify call against the [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) and generate the Tidal client from its current OpenAPI spec.
- Prefer a thin typed client per provider, built on `ofetch`, over third-party Spotify SDKs, unless an SDK is confirmed to use the `/items` and `/me/library` endpoints.
- No writes to the real library before M5, except to a dedicated test playlist on each service.
- Keep `server/core` free of I/O: matching, diffing and planning are pure functions over snapshots.
- Test the diff rules table-driven, one case per row of the diff table. Use Vitest, and test adapters against recorded HTTP fixtures.
- Secrets stay out of the repo; maintain `.env.example`.
- Ask before adding dependencies outside the stack. Record any deviation from this plan as a short decision note in `docs/decisions/`.
- Start by writing a `CLAUDE.md` in the repo that summarises this plan's conventions.

Suggested layout:

```
/app                         Nuxt app directory: pages, components, composables
/server/api                  API routes (Nitro)
/server/routes/auth          OAuth start and callback routes
/server/core                 matching, diff, planning (pure TypeScript, no I/O)
/server/providers/spotify    Spotify adapter
/server/providers/tidal      Tidal adapter
/server/db                   Drizzle schema and migrations
/server/jobs                 sync runner, run lock, scheduler (phase 2)
/shared/types                types shared by UI and server
/tests                       Vitest unit and fixture-based adapter tests
/deploy                      Dockerfile, Unraid template
/docs/decisions              decision notes
```
