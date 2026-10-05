# Crossfade plan

Oct 1, 2026 · @Oliver and Niki · Revised Oct 4, 2026

This is the living plan. It was first written as a Claude Code handoff (commit `ede371b`) around Sync, a queue and Apply. Building V0 against the real libraries changed the shape: Crossfade now follows git's model of a local main and two remotes, with pull and push as separate steps. Each change is explained in `docs/decisions/`; this document states where the design stands now.

## Overview

Crossfade is a self-hosted web app that keeps one person's Spotify and Tidal libraries in sync both ways, through a side-by-side diff in the spirit of Sonarr and Radarr. Neither service is the master. The app holds its own canonical library, **main**, and Spotify and Tidal are two equal remotes it pulls from and pushes to.

The library is small (hundreds to low thousands of songs per service), so correctness and transparency matter far more than speed. Existing SaaS tools behave like one-off migrations; this tool is built for ongoing sync.

Guiding principles:

- Never surprise the user. Pull only reads a service and updates main. Push is the only thing that writes to a service, and it always shows its changes first.
- Hard-match first: ISRC, then exact metadata across services (`0008`), before anything fuzzy, because a wrong link is worse than a missing one.
- Remember human decisions: a confirmed match, a staged change, a resolved conflict is stored and never asked again.
- State, not events: failures, unmatched songs and holds are states on the item, and they clear themselves once resolved.
- Simple over clever: full snapshots, in-memory diffing, one SQLite file, one container.

## The model: main, pull and push

Reading and writing have different costs and risks. Reading Tidal costs nothing scarce; Spotify lookups are rationed by an unpublished quota; writes change a real library. So they are separate steps, named after git (`docs/decisions/0005`). It stays a web app: git shapes the model and the words, not a command line.

| git | Crossfade |
| --- | --- |
| `main` | The canonical library: every song, which collections it belongs in, and its state on each service |
| remotes | `spotify` and `tidal`, equal peers; neither is the origin |
| remote-tracking branch | Each service's snapshot from its last pull |
| `pull spotify` | Read Spotify, work out what changed since its last snapshot, apply that to main. Never writes to a service |
| `git add` | Stage a change for the next push to one service (`0007`) |
| `push tidal` | Send the changes staged for Tidal: preview them, then write them when Oliver presses Push |
| `status` | Per collection and service: what the service is missing compared with main |
| merge conflict | A pull that would undo a newer change in main stops on that song and asks |
| `--force-with-lease` | Push re-reads the collection before writing and writes only what is still needed |
| `log` | The Activity page: every pull, push and cleanup with what it changed |

Pull Spotify, pull Tidal, push Spotify and push Tidal are four separate actions. A one-press sync (pull both, push both) waits until pull and push have earned trust on the real library.

## Scope

MVP:

- Liked songs (Spotify saved tracks, Tidal collection tracks), synced as a set.
- Playlists synced as sets of songs; ordering is ignored. A playlist on one side only can be created on the other by push.
  - Owned playlists, as planned.
  - Collaborative playlists owned by someone else are read and pushed like owned ones (`0006`).
  - Followed playlists owned by someone else are listed and paired by name so their copies on the other service are not treated as missing, but they are never read or pushed: Spotify returns 403 for their items (`0006`).
- Pull per service, with snapshots, conflicts, and a sanity guard against bad reads.
- Staging: pick which changes the next push to each service carries (`0007`).
- Push per service of what is staged, with a preview, ISRC lookup at push time, a fresh read before writing, and per-song results.
- Automatic ISRC matching; fuzzy candidates proposed for review; a manual search override.
- Unmatched songs recorded with a reason, not dropped. Songs a service no longer offers stay in main, marked unavailable there.
- Tidal playlist cleanup: merge exact duplicate copies and remove empty playlists, confirmed on the Cleanup page (`0004`).

Phase 2:

- Sync: pull both, then push both, as one press.
- Scheduled pulls (safe, since a pull never writes).
- Periodic re-check of unmatched and pulled songs, re-adding them when a service brings them back.

Stretch:

- Followed artists and saved albums, using the same canonical-entity pattern (albums matched by UPC).
- Tidal collaborative playlists (`filter[collaborators.id]=me`).

Non-goals:

- Play counts and listening history.
- Playlist ordering.
- Reading or writing playlists owned by someone else that the user only follows.
- Multiple users. The adapter interface should still allow a third service later.

## Architecture and stack

One Nuxt app in one container holds the Vue UI, Nitro server routes, a pure TypeScript core, two provider adapters and a SQLite store.

Adapters are the only code that talks to Spotify or Tidal. `server/core` (pull merge, status, matching scores, duplicate detection) is pure functions over snapshots, so it can be tested without any network. Pulls and cleanups run in-process behind one lock, never inside a request handler, and the UI follows them over server-sent events.

| Layer | Choice | Why |
| --- | --- | --- |
| App framework | Nuxt (Vue 3, TypeScript), Nitro server routes for the API | Oliver's recent stack; UI and API in one project with shared types |
| Storage | SQLite via Drizzle ORM and its migrations (applied on server start) | One file; a few thousand songs fit easily |
| App login | `nuxt-auth-utils` sealed cookie session, scrypt password hash | Fits a single username and password |
| Token encryption | Node `crypto`, AES-256-GCM, key from an env var | Built in |
| Background work | In-process runner with one lock; checkpointed, resumable runs | No external queue needed |
| Live progress | Server-sent events via h3 | One-way, simpler than WebSockets |
| Tests | Vitest | Native to the Vite toolchain |
| Packaging | One Docker image running the Nitro build on Node 24 | Unraid-native |

## Data model

Main is canonical songs, collections and memberships. Each service has links to them and a snapshot per collection.

| Table | Purpose |
| --- | --- |
| `canonical_tracks` | One real recording: isrc, title, version (Tidal's tag), artists, album, durationMs |
| `track_links` | A service's copy of a canonical song: providerTrackId (null when unmatched), status (matched, unmatched, review, ignored), method (origin, isrc, fuzzy, manual), confidence, unmatchedReason, review candidate, isPreferred |
| `collections` | Liked songs, or one playlist: kind, name |
| `collection_links` | A service's copy of a collection: providerCollectionId (null for liked), access (owned, collaborative, followed), ownerName |
| `memberships` | **Main.** A song belongs in a collection (active) or was removed (a tombstone): changedAt, changedBy (a service or user) |
| `snapshots` | What a service held in one collection at its last pull: the base its next pull compares against |
| `conflicts` | A pull that would undo a newer change in main, awaiting Oliver: keep or remove |
| `pull_holds` | A collection a pull did not merge: came back empty, would lose too many songs, or is gone from the service |
| `sync_runs`, `fetch_checkpoints`, `sync_events` | Checkpointed runs (pull, cleanup), their saved reads, and the Activity log |
| `unavailable_items` | Songs a service lists but will not play, remembered against the playlist |
| `playlist_backups` | Playlists removed by cleanup: name, description, access, items |
| `provider_accounts` | OAuth tokens for one service, encrypted, with quota pause state |

Rules the schema enforces:

- (provider, providerTrackId) is unique: a service's song maps to exactly one canonical song.
- A canonical song may have several IDs on one service (the same recording on two albums); one is preferred and used for writes.
- Removed memberships are kept as tombstones, so a stale read can never silently re-add a deliberately removed song.
- All timestamps are UTC.

## Auth and provider adapters

Spotify reshaped its Web API in February and March 2026, and Tidal's v2 API differs from older examples, so code targets the current endpoints and is checked against the changelogs and the published spec. The verified endpoint facts are kept in `CLAUDE.md`.

### App login

- One username and a password hash, both from environment variables. No user table, no reset flow.
- Sealed cookie session via `nuxt-auth-utils`. In production the whole app also sits behind Cloudflare Access.

### Provider connections

- A Connections page with Connect Spotify and Connect Tidal, using Authorization Code with PKCE for both (no client secrets needed).
- Callbacks at `<PUBLIC_BASE_URL>/auth/spotify/callback` and `/auth/tidal/callback`. Spotify rejects `localhost`, so development runs on `127.0.0.1:4050`.
- Tokens encrypted at rest with AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`, refreshed before expiry. A failed refresh marks the account "needs reconnect".

### Spotify

- Development Mode is enough for one user (owner needs Premium; up to 5 allowlisted users).
- Quota is unpublished and shared per developer account. A 429 with reason `QUOTA_EXCEEDED` is never retried: the service pauses until `Retry-After` (reported cooldowns are 13 to 18 hours), or 6 hours when none is given (`0003`).
- There is no batch ISRC lookup, so Spotify lookups are rationed and spent only at push time, on songs being pushed.
- Playlist items are readable only for playlists the user owns or collaborates on (`0006`).

### Tidal

- JSON:API at `openapi.tidal.com/v2`, PKCE, pages of 20 with a cursor, tight throttling: calls are serialised and back off on 429.
- Endpoints follow the published spec, not the original plan's table (`0001`): liked songs at `/userCollectionTracks/me/relationships/items`, owned playlists via `GET /playlists?filter[owners.id]=me`.
- Removing from a playlist needs each entry's `meta.itemId`, so the adapter reads entries first.
- Playlist items are read without a country code, so songs Tidal will not play in the account's country are kept and marked unavailable instead of silently dropping out of the read.

### Adapter interface

The interface is read-only today (`server/providers/types.ts`):

```ts
export interface MusicProvider {
  readonly id: ProviderId
  readonly isrcBatchSize: number                       // Spotify 5 (OR search), Tidal 20
  getLikedTracks(): Promise<ProviderTrack[]>           // includes songs no longer offered, available: false
  getPlaylists(): Promise<ProviderPlaylist[]>          // owned, collaborative and followed, with access
  getPlaylistTracks(playlistId: string): Promise<ProviderTrack[]>
  findByIsrcs(isrcs: string[]): Promise<IsrcLookup>
  search(query: string): Promise<ProviderTrack[]>
}
```

Push (M5) adds the writes, each returning a per-item result rather than all-or-nothing: `addLiked`, `removeLiked`, `addToPlaylist`, `removeFromPlaylist`, `createPlaylist`. The Tidal cleanup's writes live in its own job for now.

## Pull

A pull reads one service and updates main. It never writes to either service. It runs in checkpointed stages (fetch, link, pair, merge) and resumes after a pause or restart (`0003`).

1. **Fetch** liked songs and every listed playlist from the service. Followed playlists are listed but not read.
2. **Link** each song to a canonical record: an existing link, else a canonical song with the same ISRC, else a new canonical song. No lookups against the other service are made.
3. **Pair** playlists with main's collections: an existing link, else by normalised name, preferring a same-named collection this service is not on yet.
4. **Merge** each collection's changes since the service's last snapshot into main, then save the new snapshot.

Diff rules for one song in one collection, read one service at a time:

| Service (snapshot → now) | Main | Result |
| --- | --- | --- |
| no snapshot yet (first pull) | anything | Every song becomes active in main; nothing is removed, no conflicts |
| absent → present | not in main, or active | Add to main (or confirm it is there) |
| absent → present | removed after this service's snapshot | Conflict: added here, removed from main since |
| present → absent | active, unchanged since the snapshot | Remove from main (tombstone) |
| present → absent | re-added or confirmed by another service since | Conflict: removed here, added elsewhere since |
| present → present, absent → absent | anything | No change |

A pull that finds a song newly added on a service when main already has it records a **confirm** by that service; that is what turns "removed on Spotify, added on Tidal" into a conflict instead of a silent removal.

Sanity guard: if a collection comes back empty while its snapshot was not, or would lose more than 10% of its songs (at least 5), it is not merged and is **held**. Oliver accepts the removals or leaves it held. A playlist that disappears from a service is held as **gone**: keep it in main (push would recreate it) or remove its songs from main.

## Status

Status is derived, not stored: for each collection and service it compares main with the service's snapshot.

- **Add on a service**: active in main, not on the service.
- **Remove on a service**: removed in main, still on the service.
- **Unavailable**: listed on the service but not playable there; kept in main, skipped by push.
- **Not compared**: the service's copy is a followed playlist, or the service has not been pulled yet.
- **New playlist**: on main but not on the service at all; push would create it. If a same-named playlist is already there, the Library warns that pushing would make a second copy.

This is the plan's persistent queue, recast: "changes not pushed yet" falls out of main and the snapshots, and only decisions (staged changes, resolved conflicts, accepted holds) are stored.

## Staging

Push sends only the changes Oliver staged (`0007`). New changes start unstaged.

- Stage one song on one service from its row, a whole collection per service from the hero card, or everything for a service from the Main card.
- Staging is stored per collection, song and service. A pick counts only while the same change still exists; stale picks are pruned after each pull.
- A song in conflict cannot be staged until the conflict is decided.
- The Staged page shows what each push will do, removals apart from adds, and new playlists called out.

## Push (M5)

Push sends the changes staged for one service. It is the only code path that writes to Spotify or Tidal.

1. Take the run lock and create a run (kind push).
2. Show the preview (the Staged page): songs to add and to remove per collection, removals listed separately, new playlists called out.
3. Look up each song to add on the target service: an existing link, else ISRC lookup (Spotify rationed per run and paused on quota, Tidal 20 at a time). Misses go to fuzzy search, which proposes candidates for review and never auto-links.
4. Re-read each affected collection and write only what is still needed. Spotify playlists accept duplicates, so a blind add would create them.
5. Write in batches per collection (Spotify 40 for liked, Tidal 50), recording a result per song. Retry 429 and 5xx up to 3 times honouring `Retry-After`; already-present on add and already-absent on remove count as success.
6. Update the snapshot from what actually succeeded, which clears those changes from the stage. A failed write stays staged with its error and is retried on the next push; a later success clears it.

The push button follows where staged changes are waiting: Push to Spotify, Push to Tidal, or Push to both as a split button. Every button shows its staged count and opens the preview first. The same buttons appear per collection and for the whole library.

Tidal playlist cleanup (`0004`) writes to Tidal directly today, like `git gc`. Once push exists, cleanup writes should go through the same write path.

## Matching

Matching happens at push time, because only then is a song's ID on the target service needed. Pull compares ISRCs in memory, which is free, then joins songs whose cleaned-up title, artists and version are equal and whose lengths are within 2 seconds, across services only (method `metadata`, `0008`).

1. Existing link: use it. Links with method `manual` are never re-evaluated.
2. ISRC lookup on the target. Several results (the same recording on different releases): prefer the same album title, then the same explicit flag, then the closest duration.
3. Fuzzy search with a normalised "artist title" query, scoring each candidate. At or above the review floor, propose the top candidate for review. Below it, record the song as unmatched.
4. Unmatched songs keep a link row with a null ID and a reason: `not_found`, `low_confidence`, `no_isrc_match` (ISRC missed, fuzzy not tried yet) or `ignored`.

Normalisation: lowercase, Unicode-normalise, strip diacritics; pull version tags ("Remastered 2011", "Live", "Radio Edit") into a separate field; remove "feat." segments; "&" becomes "and"; collapse punctuation and whitespace.

Scoring (starting values, to tune against real data): `score = 0.45·title + 0.35·artist + 0.20·duration`. Title and artist use token-set similarity; duration is 1.0 within 2 seconds, falling to 0 at 10 seconds. A version-tag mismatch caps the score below the floor; an explicit-flag mismatch subtracts 0.05. Review floor 0.60.

Manual search (M3): open from any unmatched or review item; shows the source song, an editable query and scored candidates. Link (method `manual`), Ignore, or search again. Spotify returns at most 10 results per query, so page with an offset.

## UI

The main screen is a diff tool: Spotify on the left, main in the middle, Tidal on the right, one aligned row per canonical song.

### Header

- Navigation (Library, Review, Unmatched, Cleanup, Activity, Connections) and each service's connection or quota state.

### Library (home)

- A service card per side: Pull Spotify and Pull Tidal (or Resume after a pause), with the last pull time, changes waiting to push, and live progress over SSE.
- The push button, showing where staged changes wait; it opens the Staged page.
- Sidebar: Liked songs, then playlists grouped Mine, Collab and Followed. Within a tab, collections that need attention come before those in sync. Badges show conflicts, differences, holds, and "new" for playlists push would create.
- Hero card for the selected collection: a chip per service showing where it lives (icon greyed out with ✗ when it is not there, ✓ when it is, – when followed, "with Niki" when collaborative), and held pulls with their decision buttons.
- A push plan per service with changes, as numbered steps: create the playlist (only when the service lacks it, with any same-name warning), add n songs (noting songs unavailable on the other service that push will still look for), remove n songs. Each step shows ○ ◐ ● for how much is staged and stages on its own; Stage all stages the plan. Push progress will report against these steps.
- Rows aligned by canonical song. Each side shows its copy or a gap; the action column says what push would do, with a Spotify · main · Tidal strip of ticks and crosses. Default filter is differences only; a toggle shows everything.
- Conflicts are decided on the row: keep in main or remove from main.
- Each change has a Stage toggle per service; the hero card's push plans stage a collection's steps, and the Main card stages everything for a service.

### Staged

- What the next push to each service will do: removals first and apart, then adds per collection, new playlists and collaborative playlists called out. Unstage per song, per playlist or per service. The Push button here does the writing (M5 slice 2 onwards).

### Other screens

- **Activity**: every pull and cleanup run, its stages, counts and log; open one to see what it changed.
- **Cleanup**: Tidal duplicate and empty playlists by tier, with merge and delete for exact copies and empties.
- **Connections**: connect, reconnect or disconnect each service.
- **Review** and **Unmatched** (M3): fuzzy candidates awaiting a decision, and songs with no counterpart, using the manual search panel.

### Visual design

Black, mint and coral: big rounded cards, pill tags and buttons, heavy techno display type, and a dot-matrix equalizer motif. The reference screen is "Direction B" (`docs/direction-b.pdf`).

| Token | Value | Use |
| --- | --- | --- |
| ground | `#000000` | Page background |
| surface | `#111111` | Diff table card, secondary cards |
| raised | `#1A1A1A` | Selected collection |
| hairline | `#333333`, `#444444` | Pill outlines, dashed empty cells |
| text | `#F2F2F2` | Primary text on black |
| text-muted | `#A3A3A3`, `#8C8C8C` | Labels and metadata |
| mint | `#D4F5CF` | Collection hero card, adds, in sync, primary pills; black text on it |
| coral | `#FF4438` | Push card, removals, failures; black text on it |
| amber | `#F2B84B` | Review needed, conflicts, holds |
| Spotify badge | `#1ED760` | Spotify column only |
| Tidal badge | `#FFFFFF` | Tidal column only |

- Type: Orbitron 900 for display only (logo, collection title, counts). Space Grotesk for UI text and song titles. JetBrains Mono for ISRCs, scores and timestamps.
- Shapes: 28 px radius cards, 20 px radius rows, fully rounded pills for tags, buttons and collection links.
- Row states are filled circle badges with a glyph: mint +, coral −, amber ?, coral ! on black for failed, grey outline ∅ for unmatched, ⊘ for unavailable.
- Equalizer: a 7-row dot matrix with off dots at 12 to 16% opacity, on the push card and the runs card only.
- Accessibility: black text on mint and coral (both above 4.5:1), 44 px touch targets, and every state carries a glyph as well as a colour. Respect reduced motion.

## Deployment (not built yet)

One Docker container on Unraid, reached through the existing Cloudflare tunnel and protected by Cloudflare Access. It can be built whenever Oliver wants it deployed.

- Multi-stage Dockerfile: build the Nuxt app, copy `.output` into a slim Node 24 image, run `node .output/server/index.mjs` as a non-root user on port 8080, honouring `PUID` and `PGID`.
- One volume, `/config`: the SQLite database (`DATABASE_PATH=/config/crossfade.db`) and logs.
- `/health` endpoint and a Docker `HEALTHCHECK`; image built by GitHub Actions and pushed to GHCR, plus an Unraid template XML.
- Cloudflare: a public hostname on the tunnel and an Access application covering it. No bypass is needed for OAuth callbacks, since the provider redirects the user's own browser. Register the exact callback URLs in both developer dashboards.
- Backups: a nightly `VACUUM INTO` copy of the database, keeping the last 7, alongside Unraid's appdata backup.

Configuration is by environment variable; `.env.example` lists them all. Secrets never go in the image or the repo.

## Milestones

Work one milestone at a time and stop at each "Done when" for Oliver to verify. Nothing writes to the real library before M5, except the test playlists and the Tidal cleanup.

| Milestone | Status |
| --- | --- |
| M0 API spike | Replaced by V0 (`0002`) |
| V0 Login, connections, read adapters, dry-run diff | Done. Its dry-run sync was replaced by pull |
| Tidal playlist cleanup | Done (`0004`) |
| **M4 Main and pull** | **In progress**: pull, conflicts, holds, status and the Library page work; awaiting Oliver's check on the real library |
| **M5 Push** | **In progress**: staging, push to Tidal and push to Spotify built and in use (first real pushes 2026-10-04); creating playlists next |
| M3 Manual search and review | After M5 |
| Docker and Unraid | Whenever deployment is wanted |
| M6 Automation | Phase 2 |
| M7 Artists and albums | Stretch |

### M4 Main and pull

- [x] Memberships in main, a snapshot per service, checkpointed pull per service.
- [x] Conflicts, the sanity guard and gone playlists, decided on the Library page.
- [x] Songs a service will not play kept as unavailable.
- [x] Collaborative and followed playlists (`0006`).
- [x] Status per collection and service, and the push button showing where changes wait.

Done when: pulling Tidal then Spotify builds a main Oliver agrees with, the Library shows what each service is missing, and pulling again with nothing changed reports nothing new.

### M5 Push (MVP complete)

Built in slices (`0007`):

- [x] Staging: per-song, per-collection and per-service staging, and the Staged page as the push preview.
- [x] Push to Tidal: ISRC lookup, playlists re-read before writing, idempotent liked-song writes, per-song results and failure states (`0007`). First real push to be tried on a test playlist.
- [x] Push to Spotify: ID lookup at push time, rationed per push; stops on quota and the rest stays staged (`0007`).
- [ ] Fresh read before writing, per-song results, retries and failure states.
- [ ] Creating playlists on the other service.
- [ ] Route cleanup writes through push.

Done when: a song added on Spotify reaches Tidal after pull Spotify and push Tidal, a removal does the same, and a forced failure shows and then clears on retry.

### M3 Manual search and review

- [ ] Manual search panel, review queue, ignore, Unmatched screen.

Done when: any review item can be linked or ignored in under three clicks, and the decision survives the next push.

### M6 Automation (phase 2)

- [ ] Sync (pull both, push both) once pull and push are trusted.
- [ ] Scheduled pulls, re-check of unmatched and pulled songs, optional fuzzy auto-accept threshold.

### M7 Artists and albums (stretch)

- [ ] Followed artists and saved albums as new canonical entities, albums matched by UPC.

## Risks and open questions

The biggest risk is platform policy, not code: Spotify cut Development Mode back in 2026 and could again.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Spotify tightens Development Mode further | Writes stop working | Adapters isolated behind one interface; main stays useful read-only |
| Spotify quota exhausted (cooldowns of 13 to 18 hours) | Push stalls | Lookups only at push time, rationed per run; never retry `QUOTA_EXCEEDED`; runs pause and resume |
| Spotify refresh tokens reportedly expire after six months (unverified) | Pulls quietly stop | Refresh failure shows "needs reconnect" |
| Tidal throttling and 20-item pages | Slow pulls | Serialised calls, backoff, batching, checkpoints |
| A failed or partial read looks like deletions | Songs removed from main, then pushed | Sanity guard holds the collection; push previews removals separately |
| Wrong fuzzy match | Wrong song added on the other side | No fuzzy auto-link; links can be undone from review |
| Spotify playlists allow duplicates | Repeated adds | Fresh read before every push |
| Pushing to a collaborative playlist | Edits someone else's playlist | Shown in the preview as theirs |

Open questions:

- [ ] Should playlist renames on one side propagate to the other?
- [ ] Should a playlist on one side only be created on the other automatically, or only when chosen in the push preview?
- [ ] Should Tidal collaborative playlists be read?
- [x] How does Tidal separate owned from favourited playlists? `filter[owners.id]=me` versus `/userCollectionPlaylists` (`0001`).
- [x] Should other people's playlists be ignored? No: collaborative ones sync, followed ones are paired but not read (`0006`).

## Working instructions

- Treat API knowledge from training data as stale. Check Spotify calls against the February and March 2026 changelogs, and Tidal calls against the published OpenAPI spec.
- Thin typed clients per provider on `ofetch`; no third-party Spotify SDKs unless confirmed to use `/items` and `/me/library`.
- Keep `server/core` free of I/O.
- Test diff rules table-driven, one case per row. Test adapters against recorded HTTP fixtures.
- Secrets stay out of the repo; keep `.env.example` current.
- Ask before adding dependencies outside the stack. Record any deviation from this plan in `docs/decisions/` and update this plan to match.
