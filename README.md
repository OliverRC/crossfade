# Crossfade

Two-way sync for a personal Spotify and Tidal library, with a side-by-side diff and an editable queue. Sync only plans; Apply writes. See `docs/plan.md`.

## M0: API spike

1. Create a Spotify app (Development Mode) and a Tidal app. Register these redirect URIs:
   - `http://127.0.0.1:8888/callback/spotify`
   - `http://127.0.0.1:8888/callback/tidal`
2. On each service, create an empty playlist named something like "Crossfade test".
3. `cp .env.example .env` and fill in `SPOTIFY_CLIENT_ID`, `TIDAL_CLIENT_ID`, and the two test playlist IDs.
4. Run, for each of `spotify` and `tidal`:

   ```sh
   node spike/m0.ts auth spotify
   node spike/m0.ts read spotify
   node spike/m0.ts write-playlist spotify              # writes only to the test playlist
   node spike/m0.ts write-liked spotify <trackId>       # a track you have NOT liked; likes then unlikes it
   ```

Raw responses land in `spike/out/` (gitignored).

M0 is done when every command succeeds on both services and `read tidal` shows that `filter[owners.id]=me` returns only your own playlists.
