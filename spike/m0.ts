// M0 API spike: throwaway. Proves every adapter operation against the real accounts.
// Usage (from the repo root, with .env filled in):
//   node spike/m0.ts auth <spotify|tidal>         OAuth with PKCE, stores tokens in spike/.tokens.json
//   node spike/m0.ts read <spotify|tidal>         liked tracks, owned playlists, one playlist, ISRC lookup, search
//   node spike/m0.ts write-playlist <spotify|tidal>   add then remove one track on the test playlist
//   node spike/m0.ts write-liked <spotify|tidal> <trackId>   like then unlike a track you have NOT liked
// Raw responses are saved to spike/out/ for inspection and later fixtures.

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

type Provider = 'spotify' | 'tidal'
type Tokens = { accessToken: string, refreshToken?: string, expiresAt: number, scope?: string }

if (existsSync('.env')) process.loadEnvFile('.env')

const PORT = 8888
const TOKENS_FILE = 'spike/.tokens.json'
const OUT_DIR = 'spike/out'

const config = {
  spotify: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    apiBase: 'https://api.spotify.com/v1',
    scopes: ['user-library-read', 'user-library-modify', 'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public'],
  },
  tidal: {
    authorizeUrl: 'https://login.tidal.com/authorize',
    tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
    apiBase: 'https://openapi.tidal.com/v2',
    scopes: ['collection.read', 'collection.write', 'playlists.read', 'playlists.write', 'search.read', 'user.read'],
  },
} as const

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example)`)
  return value
}

const clientId = (p: Provider) => env(p === 'spotify' ? 'SPOTIFY_CLIENT_ID' : 'TIDAL_CLIENT_ID')
const redirectUri = (p: Provider) => `http://127.0.0.1:${PORT}/callback/${p}`

function loadTokens(): Partial<Record<Provider, Tokens>> {
  return existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) : {}
}

function saveTokens(p: Provider, t: Tokens) {
  writeFileSync(TOKENS_FILE, JSON.stringify({ ...loadTokens(), [p]: t }, null, 2), { mode: 0o600 })
}

function dump(name: string, data: unknown) {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(`${OUT_DIR}/${name}.json`, JSON.stringify(data, null, 2))
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------- OAuth ----------

async function tokenRequest(p: Provider, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(config[p].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(p), ...params }),
  })
  const body = await res.json() as any
  if (!res.ok) throw new Error(`${p} token request failed ${res.status}: ${JSON.stringify(body)}`)
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? params.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  }
}

async function auth(p: Provider) {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const url = new URL(config[p].authorizeUrl)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(p),
    redirect_uri: redirectUri(p),
    scope: config[p].scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString()

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
      if (u.pathname !== `/callback/${p}`) { res.writeHead(404).end(); return }
      const error = u.searchParams.get('error')
      const ok = !error && u.searchParams.get('state') === state && u.searchParams.get('code')
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' })
        .end(ok ? 'Crossfade spike: connected. You can close this tab.' : `Failed: ${error ?? 'state mismatch'}`)
      server.close()
      ok ? resolve(u.searchParams.get('code')!) : reject(new Error(`${p} authorize failed: ${error ?? 'state mismatch'}`))
    }).listen(PORT, '127.0.0.1')
    console.log(`Open this URL to connect ${p}:\n\n${url}\n`)
    spawn('xdg-open', [url.toString()], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  })

  const tokens = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(p), code_verifier: verifier })
  saveTokens(p, tokens)
  console.log(`${p}: connected. Scopes: ${tokens.scope ?? '(not reported)'}; refresh token: ${tokens.refreshToken ? 'yes' : 'NO'}`)
}

async function accessToken(p: Provider): Promise<string> {
  const t = loadTokens()[p]
  if (!t) throw new Error(`${p} not connected: run "node spike/m0.ts auth ${p}" first`)
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken
  if (!t.refreshToken) throw new Error(`${p} token expired and there is no refresh token: re-run auth`)
  console.log(`${p}: refreshing token`)
  const fresh = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: t.refreshToken })
  saveTokens(p, fresh)
  return fresh.accessToken
}

// ---------- HTTP with 429 handling ----------

async function api(p: Provider, method: string, path: string, body?: unknown): Promise<any> {
  const url = path.startsWith('http') ? path : `${config[p].apiBase}${path}`
  const contentType = p === 'tidal' ? 'application/vnd.api+json' : 'application/json'
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken(p)}`,
        Accept: contentType,
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt
      const text = await res.text()
      console.log(`  ${res.status} on ${method} ${path} (attempt ${attempt}), waiting ${retryAfter}s ${text.includes('QUOTA_EXCEEDED') ? '[QUOTA_EXCEEDED]' : ''}`)
      await sleep(retryAfter * 1000)
      continue
    }
    const text = await res.text()
    const json = text ? safeJson(text) : null
    if (!res.ok) throw new Error(`${p} ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`)
    if (p === 'tidal') await sleep(250) // serialise and stay under Tidal's throttle
    return json
  }
}

function safeJson(text: string) {
  try { return JSON.parse(text) } catch { return text }
}

// ---------- Spotify ----------

async function spotifyPages(path: string): Promise<any[]> {
  const items: any[] = []
  let next: string | null = path
  while (next) {
    const page: any = await api('spotify', 'GET', next)
    items.push(...page.items)
    next = page.next
  }
  return items
}

const spotifyTrackOf = (entry: any) => entry.item ?? entry.track

function summariseSpotify(t: any) {
  return `${t.name} - ${t.artists?.map((a: any) => a.name).join(', ')} [isrc ${t.external_ids?.isrc ?? 'MISSING'}] ${t.id}`
}

async function spotifyRead() {
  const me = await api('spotify', 'GET', '/me')
  console.log(`Spotify user: ${me.id}`)

  const liked = await spotifyPages('/me/tracks?limit=50')
  dump('spotify-liked', liked)
  const likedTracks = liked.map(spotifyTrackOf)
  const withIsrc = likedTracks.filter((t: any) => t?.external_ids?.isrc).length
  console.log(`Liked tracks: ${liked.length}; with ISRC: ${withIsrc}`)
  likedTracks.slice(0, 3).forEach((t: any) => console.log(`  ${summariseSpotify(t)}`))

  const playlists = await spotifyPages('/me/playlists?limit=50')
  dump('spotify-playlists', playlists)
  const owned = playlists.filter((pl: any) => pl.owner?.id === me.id)
  console.log(`Playlists: ${playlists.length}; owned: ${owned.length}`)
  owned.forEach((pl: any) => console.log(`  ${pl.name} (${pl.id})`))

  const sample = owned.find((pl: any) => pl.id !== process.env.SPOTIFY_TEST_PLAYLIST_ID) ?? owned[0]
  if (sample) {
    const entries = await spotifyPages(`/playlists/${sample.id}/items?limit=50`)
    dump('spotify-playlist-items', entries)
    console.log(`Playlist "${sample.name}": ${entries.length} items; entry keys: ${Object.keys(entries[0] ?? {}).join(', ')}`)
  }

  const isrc = likedTracks.find((t: any) => t?.external_ids?.isrc)?.external_ids.isrc
  if (isrc) {
    const found = await api('spotify', 'GET', `/search?q=${encodeURIComponent(`isrc:${isrc}`)}&type=track&limit=10`)
    dump('spotify-isrc', found)
    console.log(`ISRC ${isrc}: ${found.tracks.items.length} result(s)`)
    found.tracks.items.forEach((t: any) => console.log(`  ${summariseSpotify(t)} album "${t.album?.name}"`))
  }

  const first = likedTracks[0]
  if (first) {
    const q = `${first.artists[0].name} ${first.name}`
    const found = await api('spotify', 'GET', `/search?q=${encodeURIComponent(q)}&type=track&limit=10`)
    dump('spotify-search', found)
    console.log(`Search "${q}": ${found.tracks.items.length} result(s); total reported ${found.tracks.total}`)
  }
}

async function spotifyWritePlaylist() {
  const playlistId = env('SPOTIFY_TEST_PLAYLIST_ID')
  const liked = await api('spotify', 'GET', '/me/tracks?limit=1')
  const track = spotifyTrackOf(liked.items[0])
  console.log(`Adding ${summariseSpotify(track)} to test playlist`)
  await api('spotify', 'POST', `/playlists/${playlistId}/items`, { uris: [track.uri] })
  const after = await spotifyPages(`/playlists/${playlistId}/items?limit=50`)
  console.log(`  present after add: ${after.some(e => spotifyTrackOf(e)?.uri === track.uri)}`)
  await api('spotify', 'DELETE', `/playlists/${playlistId}/items`, { items: [{ uri: track.uri }] })
  const final = await spotifyPages(`/playlists/${playlistId}/items?limit=50`)
  console.log(`  present after remove: ${final.some(e => spotifyTrackOf(e)?.uri === track.uri)}`)
}

async function spotifyWriteLiked(trackId: string) {
  const uri = `spotify:track:${trackId}`
  const [already] = await api('spotify', 'GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`)
  if (already) throw new Error(`${uri} is already liked; pick a track you have not liked so the test leaves your library unchanged`)
  await api('spotify', 'PUT', `/me/library?uris=${encodeURIComponent(uri)}`)
  console.log(`  liked after PUT: ${(await api('spotify', 'GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`))[0]}`)
  await api('spotify', 'DELETE', `/me/library?uris=${encodeURIComponent(uri)}`)
  console.log(`  liked after DELETE: ${(await api('spotify', 'GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`))[0]}`)
}

// ---------- Tidal ----------

async function tidalPages(path: string): Promise<{ data: any[], included: any[] }> {
  const data: any[] = []
  const included: any[] = []
  let next: string | null = path
  while (next) {
    const page: any = await api('tidal', 'GET', next)
    data.push(...(Array.isArray(page.data) ? page.data : [page.data]))
    included.push(...(page.included ?? []))
    next = page.links?.next ?? null
  }
  return { data, included }
}

function summariseTidal(t: any) {
  const a = t?.attributes ?? {}
  return `${a.title}${a.version ? ` (${a.version})` : ''} [isrc ${a.isrc ?? 'MISSING'}, ${a.duration}, explicit ${a.explicit}] ${t?.id}`
}

async function tidalCountry(): Promise<string> {
  const me = await api('tidal', 'GET', '/users/me')
  dump('tidal-me', me)
  return me.data.attributes.country
}

async function tidalRead() {
  const country = await tidalCountry()
  console.log(`Tidal country: ${country}`)

  const liked = await tidalPages('/userCollectionTracks/me/relationships/items?include=items')
  dump('tidal-liked', liked)
  const tracks = liked.included.filter(r => r.type === 'tracks')
  console.log(`Liked tracks: ${liked.data.length}; included track resources: ${tracks.length}; with ISRC: ${tracks.filter(t => t.attributes?.isrc).length}`)
  tracks.slice(0, 3).forEach(t => console.log(`  ${summariseTidal(t)}`))
  console.log(`  track relationships available: ${Object.keys(tracks[0]?.relationships ?? {}).join(', ')}`)

  const owned = await tidalPages(`/playlists?filter[owners.id]=me&countryCode=${country}`)
  dump('tidal-playlists-owned', owned)
  const favourited = await tidalPages('/userCollectionPlaylists/me/relationships/items?include=items')
  dump('tidal-playlists-collection', favourited)
  const ownedIds = new Set(owned.data.map(pl => pl.id))
  console.log(`Owned playlists (filter[owners.id]=me): ${owned.data.length}`)
  owned.data.forEach(pl => console.log(`  ${pl.attributes?.name} (${pl.id})`))
  const notOwned = favourited.data.filter(pl => !ownedIds.has(pl.id))
  console.log(`Collection playlists: ${favourited.data.length}; of which not owned: ${notOwned.length}`)

  const sample = owned.data.find(pl => pl.id !== process.env.TIDAL_TEST_PLAYLIST_ID) ?? owned.data[0]
  if (sample) {
    const items = await tidalPages(`/playlists/${sample.id}/relationships/items?countryCode=${country}&include=items`)
    dump('tidal-playlist-items', items)
    console.log(`Playlist "${sample.attributes?.name}": ${items.data.length} items; first entry: ${JSON.stringify(items.data[0])}`)
  }

  const isrc = tracks.find(t => t.attributes?.isrc)?.attributes.isrc
  if (isrc) {
    const found = await api('tidal', 'GET', `/tracks?filter[isrc]=${isrc}&countryCode=${country}`)
    dump('tidal-isrc', found)
    console.log(`ISRC ${isrc}: ${found.data.length} result(s)`)
    found.data.forEach((t: any) => console.log(`  ${summariseTidal(t)}`))
  }

  const first = tracks[0]
  if (first) {
    const q = first.attributes.title
    const found = await api('tidal', 'GET', `/searchResults/${encodeURIComponent(q)}/relationships/tracks?countryCode=${country}&include=tracks`)
    dump('tidal-search', found)
    console.log(`Search "${q}": ${found.data.length} result(s) on the first page; next page: ${Boolean(found.links?.next)}`)
  }
}

async function tidalWritePlaylist() {
  const playlistId = env('TIDAL_TEST_PLAYLIST_ID')
  const country = await tidalCountry()
  const liked = await api('tidal', 'GET', '/userCollectionTracks/me/relationships/items')
  const trackId = liked.data[0].id
  console.log(`Adding track ${trackId} to test playlist`)
  await api('tidal', 'POST', `/playlists/${playlistId}/relationships/items`, {
    data: [{ id: trackId, type: 'tracks' }],
    meta: { onDuplicates: 'SKIP' },
  })
  const after = await tidalPages(`/playlists/${playlistId}/relationships/items?countryCode=${country}`)
  const entry = after.data.find(e => e.id === trackId)
  console.log(`  present after add: ${Boolean(entry)}; entry: ${JSON.stringify(entry)}`)
  if (!entry?.meta?.itemId) throw new Error('No meta.itemId on the playlist entry; removal needs it')
  await api('tidal', 'DELETE', `/playlists/${playlistId}/relationships/items`, {
    data: [{ id: trackId, type: 'tracks', meta: { itemId: entry.meta.itemId } }],
  })
  const final = await tidalPages(`/playlists/${playlistId}/relationships/items?countryCode=${country}`)
  console.log(`  present after remove: ${final.data.some(e => e.id === trackId)}`)
}

async function tidalWriteLiked(trackId: string) {
  const isLiked = async () => (await tidalPages('/userCollectionTracks/me/relationships/items')).data.some(e => e.id === trackId)
  if (await isLiked()) throw new Error(`Track ${trackId} is already liked; pick a track you have not liked so the test leaves your library unchanged`)
  await api('tidal', 'POST', '/userCollectionTracks/me/relationships/items', { data: [{ id: trackId, type: 'tracks' }] })
  console.log(`  liked after POST: ${await isLiked()}`)
  await api('tidal', 'DELETE', '/userCollectionTracks/me/relationships/items', { data: [{ id: trackId, type: 'tracks' }] })
  console.log(`  liked after DELETE: ${await isLiked()}`)
}

// ---------- CLI ----------

const [command, provider, arg] = process.argv.slice(2) as [string, Provider, string | undefined]
if (provider !== 'spotify' && provider !== 'tidal') {
  console.log('Usage: node spike/m0.ts <auth|read|write-playlist|write-liked> <spotify|tidal> [trackId]')
  process.exit(1)
}

const commands: Record<string, () => Promise<void>> = {
  'auth': () => auth(provider),
  'read': () => provider === 'spotify' ? spotifyRead() : tidalRead(),
  'write-playlist': () => provider === 'spotify' ? spotifyWritePlaylist() : tidalWritePlaylist(),
  'write-liked': () => {
    if (!arg) throw new Error('write-liked needs a track ID you have not liked')
    return provider === 'spotify' ? spotifyWriteLiked(arg) : tidalWriteLiked(arg)
  },
}

try {
  if (!commands[command]) throw new Error(`Unknown command ${command}`)
  await commands[command]()
} catch (error) {
  console.error(`\n${(error as Error).message}`)
  process.exit(1)
}
