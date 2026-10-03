// Authorization Code with PKCE for both services. Client secrets are not needed for PKCE and are not sent.
import { createHash, randomBytes } from 'node:crypto'
import { ofetch } from 'ofetch'
import type { ProviderId } from '../../shared/types'
import { providerCredentials, redirectUri } from '../utils/config'

export const OAUTH = {
  spotify: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: ['user-library-read', 'user-library-modify', 'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public'],
  },
  tidal: {
    authorizeUrl: 'https://login.tidal.com/authorize',
    tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
    scopes: ['collection.read', 'collection.write', 'playlists.read', 'playlists.write', 'search.read', 'user.read'],
  },
} as const

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  scopes: string[]
}

function clientId(provider: ProviderId): string {
  const credentials = providerCredentials(provider)
  if (!credentials) throw new Error(`${provider.toUpperCase()}_CLIENT_ID is not set`)
  return credentials.clientId
}

export function createPkce() {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('hex') }
}

export function authorizeUrl(provider: ProviderId, state: string, challenge: string): string {
  const url = new URL(OAUTH[provider].authorizeUrl)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(provider),
    redirect_uri: redirectUri(provider),
    scope: OAUTH[provider].scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString()
  return url.toString()
}

async function tokenRequest(provider: ProviderId, params: Record<string, string>, previousRefresh: string | null = null): Promise<TokenSet> {
  const body = await ofetch<any>(OAUTH[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(provider), ...params }).toString(),
  })
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt: new Date(Date.now() + Number(body.expires_in) * 1000),
    scopes: String(body.scope ?? '').split(/[\s,]+/).filter(Boolean),
  }
}

export function exchangeCode(provider: ProviderId, code: string, verifier: string) {
  return tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(provider), code_verifier: verifier })
}

export function refreshTokens(provider: ProviderId, refreshToken: string) {
  return tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken)
}
