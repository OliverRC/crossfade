# Crossfade

Self-hosted two-way sync for one person's Spotify and Tidal libraries (liked songs and playlists), with a side-by-side diff in the spirit of Sonarr.

It works like git. Crossfade keeps its own canonical library, **main**, and treats Spotify and Tidal as two equal remotes:

- **Pull** reads one service and brings its changes since the last pull into main. It never writes to a service.
- **Push** makes one service match main. It is the only thing that writes, and it always shows its changes first.

The plan is `docs/plan.md`; the reasons it changed along the way are in `docs/decisions/`.

## Status

Milestone **M4 Main and pull** is built and waiting to be checked against the real library. **Nothing is written to Spotify or Tidal yet**, apart from the Tidal playlist cleanup, which only runs when confirmed on the Cleanup page.

| | |
| --- | --- |
| Working | Login; connecting both services; pull per service (checkpointed, resumable, pauses on Spotify quota); main with conflicts and a sanity guard for bad reads; owned, collaborative and followed playlists; the Library diff showing what each service is missing; Activity log; Tidal duplicate and empty playlist cleanup |
| Next: M5 Push | Preview per service, hold back changes, look up song IDs at push time, re-read before writing, per-song results and retries |
| Then | M3 manual search and review; Docker and Unraid packaging; later, one-press sync and scheduled pulls |

M4 is done when pulling Tidal then Spotify builds a main that matches the real libraries, the Library shows what each service is missing, and pulling again with nothing changed reports nothing new.

## Run it

1. Register a Spotify app and a Tidal app with these redirect URIs:
   - `http://127.0.0.1:4050/auth/spotify/callback`
   - `http://127.0.0.1:4050/auth/tidal/callback`
2. Fill in `.env` (see `.env.example`): the client IDs, plus `APP_PASSWORD_HASH` from `pnpm hash-password '<password>'`.
3. `pnpm install`, then `pnpm dev`, and open http://localhost:4050 (it redirects to `127.0.0.1:4050`, which Spotify requires for sign-in).
4. Log in, connect both services on Connections, then press Pull Tidal and Pull Spotify on the Library page.

## Develop

Node 24 and pnpm.

```sh
pnpm test        # unit tests and an end-to-end pull against fake services
pnpm typecheck
pnpm db:generate --name <change>   # after editing server/db/schema.ts; migrations apply on server start
```

Conventions for contributors (and Claude Code) are in `CLAUDE.md`.
