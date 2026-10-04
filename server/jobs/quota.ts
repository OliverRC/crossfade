// A service's rate limit, recorded on its account so no request is sent before it clears (docs/decisions/0003).
import { eq } from 'drizzle-orm'
import type { ProviderId, RunPause } from '../../shared/types'
import type { QuotaError } from '../providers/http'
import { schema, useDb } from '../utils/db'

/** No Retry-After: probe again in 6 hours (reported Spotify cooldowns run 13 to 18). */
const QUOTA_FALLBACK_MS = 6 * 3600_000

export const providerNames: Record<ProviderId, string> = { spotify: 'Spotify', tidal: 'Tidal' }

export function quotaBlockedUntil(provider: ProviderId): string | null {
  const until = useDb().select({ until: schema.providerAccounts.quotaBlockedUntil }).from(schema.providerAccounts)
    .where(eq(schema.providerAccounts.provider, provider)).get()?.until
  return until && Date.parse(until) > Date.now() ? until : null
}

/** Record a quota error on the account (once) and describe the pause it causes. */
export function quotaPause(provider: ProviderId, error?: QuotaError): RunPause {
  const existing = quotaBlockedUntil(provider)
  const resumeAt = existing ?? new Date(Date.now() + (error?.retryAfterSeconds ? error.retryAfterSeconds * 1000 : QUOTA_FALLBACK_MS)).toISOString()
  if (!existing) {
    useDb().update(schema.providerAccounts).set({
      quotaBlockedUntil: resumeAt,
      quotaHitAt: new Date().toISOString(),
      quotaResetSource: error?.retryAfterSeconds ? 'retry-after' : 'estimate',
      quotaMessage: error?.message ?? null,
    }).where(eq(schema.providerAccounts.provider, provider)).run()
  }
  return { provider, reason: 'quota', resumeAt, message: `${providerNames[provider]} quota used up${error?.retryAfterSeconds ? '' : ' (no reset time given)'}` }
}
