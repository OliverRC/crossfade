import type { ProviderId } from '../../shared/types'

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:4050').replace(/\/$/, '')
}

export function databasePath(): string {
  return process.env.DATABASE_PATH || './data/crossfade.db'
}

export function providerCredentials(provider: ProviderId): { clientId: string, clientSecret: string | null } | null {
  const prefix = provider.toUpperCase()
  const clientId = process.env[`${prefix}_CLIENT_ID`]
  if (!clientId) return null
  return { clientId, clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || null }
}

export function redirectUri(provider: ProviderId): string {
  return `${publicBaseUrl()}/auth/${provider}/callback`
}

/** Spotify lookups (search requests) one push may spend before leaving the rest staged; the quota is unpublished. */
export function spotifyLookupBudget(): number {
  const n = Number(process.env.SPOTIFY_LOOKUPS_PER_RUN)
  return Number.isFinite(n) && n > 0 ? n : 150
}
