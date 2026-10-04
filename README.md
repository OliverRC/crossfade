# Crossfade

Self-hosted two-way sync for one person's Spotify and Tidal libraries: liked songs, and the playlists you own or collaborate on.

## One primary, two remotes

Syncing two libraries both ways has a classic trap: if each side is a primary, a song on Spotify but not on Tidal is ambiguous. Was it added on Spotify, or removed on Tidal? Guess wrong and a deletion comes back, or a new song disappears.

Crossfade avoids having two primaries by borrowing the model of distributed version control. It keeps one canonical library of its own, **main**, and treats Spotify and Tidal as two equal remotes, neither of them in charge:

| git | Crossfade |
| --- | --- |
| `main` | The canonical library: every song, which playlists it belongs in, and its state on each service |
| remotes | `spotify` and `tidal` |
| remote-tracking branches | The last snapshot read from each service, the base the next pull compares against |
| `pull` | Read one service, work out what changed there since its last snapshot, and apply those changes to main. Never writes to a service |
| `add` | Stage a change: pick it for the next push to one service. New changes start unstaged |
| `push` | Send what is staged to one service. The only thing that writes, and it always shows its changes first |
| merge conflict | A pull that would undo a newer change in main, such as removing a song the other service just added. It stops on that song and asks |
| `status` | The Library page: per playlist, what each service is missing compared with main |
| `log` | The Activity page: every pull, push and cleanup, and what it changed |

Because every pull compares a service with its own last snapshot, the question becomes "what changed on Tidal?" rather than "which side is right?", and the answer goes into main. A sync is then just pull both, push both.

The plan is `docs/plan.md`; the reasons it changed along the way are in `docs/decisions/` (the git model is `0005`).

## Status

Milestone **M4 Main and pull** is built and waiting to be checked against the real library, and **M5 Push** has started with staging. **Nothing is written to Spotify or Tidal yet**, apart from the Tidal playlist cleanup, which only runs when confirmed on the Cleanup page.

| | |
| --- | --- |
| Working | Login; connecting both services; pull per service (checkpointed, resumable, pauses on Spotify quota); main with conflicts and a sanity guard for bad reads; owned, collaborative and followed playlists; the Library diff showing what each service is missing; Activity log; Tidal duplicate and empty playlist cleanup |
| Building: M5 Push | Done: staging changes per song, playlist or service, and the Staged page that previews each push. Next: push to Tidal, then Spotify (ID lookups at push time, re-read before writing, per-song results and retries), then creating playlists |
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
