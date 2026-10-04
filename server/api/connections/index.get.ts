import { and, desc, eq } from 'drizzle-orm'
import { PROVIDERS, type ConnectionView } from '../../../shared/types'
import { getAccount } from '../../utils/accounts'
import { providerCredentials, redirectUri } from '../../utils/config'
import { schema, useDb } from '../../utils/db'

/** A quota hit stays visible for a day after it clears, so "it happened" is not lost. */
const SHOW_CLEARED_FOR_MS = 24 * 3600_000

export default defineEventHandler((): ConnectionView[] => {
  return PROVIDERS.map((provider) => {
    const latestRun = useDb().select({ counts: schema.syncRuns.counts }).from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.kind, 'pull'), eq(schema.syncRuns.provider, provider))).orderBy(desc(schema.syncRuns.id)).limit(1).get()
    const account = getAccount(provider)
    const retryAt = account?.quotaBlockedUntil
    const recent = retryAt && Date.now() - Date.parse(retryAt) < SHOW_CLEARED_FOR_MS
    return {
      provider,
      configured: providerCredentials(provider) !== null,
      redirectUri: redirectUri(provider),
      connected: Boolean(account),
      providerUserId: account?.providerUserId ?? null,
      needsReconnect: account?.needsReconnect ?? false,
      quota: recent
        ? { blocked: Date.parse(retryAt) > Date.now(), hitAt: account.quotaHitAt, retryAt, source: account.quotaResetSource ?? 'estimate', message: account.quotaMessage }
        : null,
      requestsLastRun: latestRun?.counts?.[`${provider}Requests`] ?? null,
      scopes: account?.scopes.split(' ').filter(Boolean) ?? [],
    }
  })
})
