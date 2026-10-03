# Crossfade

Two-way sync for a personal Spotify and Tidal library, with a side-by-side diff and an editable queue. Sync only plans; Apply writes. See `docs/plan.md`.

Status: V0. Sign in, connect both services, run a dry-run sync, and see the diff. Nothing is written to either service yet.

## Run it

1. Register a Spotify app and a Tidal app with these redirect URIs:
   - `http://127.0.0.1:4050/auth/spotify/callback`
   - `http://127.0.0.1:4050/auth/tidal/callback`
2. Fill in `.env` (see `.env.example`): the client IDs, plus `APP_PASSWORD_HASH` from `pnpm hash-password '<password>'`.
3. `pnpm install`, then `pnpm dev`, and open http://localhost:4050 (it redirects to `127.0.0.1:4050`, which Spotify requires for sign-in).
4. Log in, connect both services on Connections, then press Sync on the library page.

## Develop

```sh
pnpm test        # unit tests and a dry run against fake providers
pnpm typecheck
pnpm db:generate --name <change>   # after editing server/db/schema.ts
```
