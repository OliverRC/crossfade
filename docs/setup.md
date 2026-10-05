# Setting up the Spotify and Tidal apps

Crossfade talks to each service through a developer app that you register once. Both use OAuth Authorization Code with PKCE, so Crossfade needs only each app's **client ID**; no client secret is sent or stored. Checked against the developer documentation on 2026-10-05.

One pair of apps serves both places Crossfade runs: register every redirect URI below on the same app. Spotify allows only one Development Mode app per developer, so a second Spotify app for production is not an option.

| Where | `PUBLIC_BASE_URL` | Redirect URIs |
| --- | --- | --- |
| Local (`pnpm dev`) | `http://127.0.0.1:4050` | `http://127.0.0.1:4050/auth/spotify/callback`, `http://127.0.0.1:4050/auth/tidal/callback` |
| Unraid, behind Cloudflare | `https://crossfade.<your-domain>` | `https://crossfade.<your-domain>/auth/spotify/callback`, `https://crossfade.<your-domain>/auth/tidal/callback` |

The redirect URI Crossfade sends is always `<PUBLIC_BASE_URL>/auth/<service>/callback`, and it must match a registered one exactly: scheme, host, port and path. The Connections page shows the URI Crossfade is using for each service.

## Spotify

1. Sign in at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) with the Spotify account whose library Crossfade will sync. Development Mode requires that account to have **Premium**.
2. **Create app**. Give it a name and a description (both appear on Spotify's consent screen), add the redirect URIs from the table, and choose **Web API** when asked which APIs the app uses. Accept the Developer Terms and save.
3. Copy the **Client ID** from the app's settings into `SPOTIFY_CLIENT_ID`. The client secret is not needed.
4. Under **User Management**, make sure your own Spotify account is listed. A Development Mode app accepts at most five allowlisted users; Crossfade needs one.

Rules that bite:

- **No `localhost`.** Spotify rejects `localhost` redirect URIs; loopback must be the literal `127.0.0.1` (or `[::1]`). That is why `pnpm dev` serves on `127.0.0.1:4050` and redirects `localhost:4050` there.
- **HTTPS everywhere else.** Plain HTTP is accepted only for loopback addresses, so the Unraid URI must be the `https://` Cloudflare hostname, not the server's LAN address.
- **Quota.** Development Mode has an unpublished request quota shared across your developer account. A breach answers `429 QUOTA_EXCEEDED` with a long cooldown (23.5 hours observed on 2026-10-03). Crossfade never retries it and caps lookups per push with `SPOTIFY_LOOKUPS_PER_RUN`.

## Tidal

1. Sign in at [developer.tidal.com](https://developer.tidal.com/) with the Tidal account whose library Crossfade will sync, and open the **Dashboard**.
2. **Create an app** and name it.
3. In the app's **settings**, add the redirect URIs from the table. A redirect URI is required for the Authorization Code flow.
4. Allow the app to claim these scopes, which Crossfade requests at sign-in:
   `user.read`, `collection.read`, `collection.write`, `playlists.read`, `playlists.write`, `search.read`.
   Without the two `write` scopes Crossfade can pull but not push, and the Push button says to reconnect.
5. Copy the **Client ID** into `TIDAL_CLIENT_ID`. The client secret is not needed.

Some developers report a wait before Tidal clears an app for user scopes. If signing in fails with a scope error, check the scopes in the app's settings first.

## Then, in Crossfade

1. Fill in `.env` from `.env.example`: the two client IDs, `PUBLIC_BASE_URL`, `APP_USERNAME`, `APP_PASSWORD_HASH` (from `pnpm hash-password '<password>'`), and two random secrets of at least 32 characters for `NUXT_SESSION_PASSWORD` and `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).
2. Start Crossfade, log in, and press **Connect** for each service on the Connections page. Each service shows its consent screen once; Crossfade stores the tokens encrypted and refreshes them itself.
3. If a service later shows **needs reconnect** (a refresh failed, or new scopes are needed), press Connect again.

## Moving to Unraid

The Docker image and Unraid template are not built yet (see the plan's Deployment section). When they are:

- Add the `https://` redirect URIs to the **same** two apps; keep the local ones so `pnpm dev` still works.
- Set `PUBLIC_BASE_URL` to the Cloudflare hostname. Cloudflare Access needs no bypass for the callbacks: the service redirects your own browser, which already holds the Access session.
- `TOKEN_ENCRYPTION_KEY` encrypts the stored tokens. Keep it with the database: a different key cannot read them, and both services must then be connected again.
- The database moves to the `/config` volume (`DATABASE_PATH=/config/crossfade.db`). Copying `data/crossfade.db` there carries main, snapshots, staging and history across; connect both services again if the encryption key changed.
