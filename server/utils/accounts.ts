import { eq } from 'drizzle-orm'
import type { ProviderId } from '../../shared/types'
import { refreshTokens, type TokenSet } from '../providers/oauth'
import { decrypt, encrypt } from './crypto'
import { schema, useDb } from './db'

export class NeedsReconnectError extends Error {
  constructor(readonly provider: ProviderId) {
    super(`${provider} needs reconnecting`)
  }
}

export function getAccount(provider: ProviderId) {
  return useDb().select().from(schema.providerAccounts).where(eq(schema.providerAccounts.provider, provider)).get()
}

export function saveAccount(provider: ProviderId, tokens: TokenSet, extra: { providerUserId: string, country?: string | null }) {
  const row = {
    provider,
    providerUserId: extra.providerUserId,
    accessToken: encrypt(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt.toISOString(),
    scopes: tokens.scopes.join(' '),
    country: extra.country ?? null,
    needsReconnect: false,
    updatedAt: new Date().toISOString(),
  }
  useDb().insert(schema.providerAccounts).values(row).onConflictDoUpdate({ target: schema.providerAccounts.provider, set: row }).run()
}

export function deleteAccount(provider: ProviderId) {
  useDb().delete(schema.providerAccounts).where(eq(schema.providerAccounts.provider, provider)).run()
}

const refreshing = new Map<ProviderId, Promise<string>>()

/** A valid access token, refreshed a minute before expiry. A failed refresh marks the account "needs reconnect". */
export async function getAccessToken(provider: ProviderId): Promise<string> {
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw new NeedsReconnectError(provider)
  if (Date.parse(account.expiresAt) - Date.now() > 60_000) return decrypt(account.accessToken)
  if (!account.refreshToken) return markNeedsReconnect(provider)

  if (!refreshing.has(provider)) {
    refreshing.set(provider, (async () => {
      try {
        const tokens = await refreshTokens(provider, decrypt(account.refreshToken!))
        saveAccount(provider, tokens, { providerUserId: account.providerUserId, country: account.country })
        return tokens.accessToken
      } catch {
        return markNeedsReconnect(provider)
      } finally {
        refreshing.delete(provider)
      }
    })())
  }
  return refreshing.get(provider)!
}

function markNeedsReconnect(provider: ProviderId): never {
  useDb().update(schema.providerAccounts).set({ needsReconnect: true }).where(eq(schema.providerAccounts.provider, provider)).run()
  throw new NeedsReconnectError(provider)
}
