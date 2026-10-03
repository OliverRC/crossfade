// Shared HTTP client for provider APIs: serialised per provider, retries 429 and 5xx honouring Retry-After.
import { FetchError, ofetch } from 'ofetch'
import type { ProviderId } from '../../shared/types'

export class ProviderError extends Error {
  constructor(readonly provider: ProviderId, readonly status: number, message: string) {
    super(message)
  }
}

/**
 * The service will not serve us for a while: Spotify's QUOTA_EXCEEDED (reported cooldowns of hours),
 * or any 429 asking us to wait more than a minute. Never retried; the caller pauses that service.
 */
export class QuotaError extends ProviderError {
  constructor(provider: ProviderId, message: string, readonly retryAfterSeconds: number | null) {
    super(provider, 429, message)
  }
}

/** Requests sent per provider since start, so runs can report what they cost. */
export const requestCounts: Record<ProviderId, number> = { spotify: 0, tidal: 0 }
const LONG_WAIT_SECONDS = 60

const queues = new Map<ProviderId, Promise<unknown>>()
const MIN_GAP_MS: Record<ProviderId, number> = { spotify: 0, tidal: 250 }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Run calls to one provider one at a time, with a minimum gap (Tidal throttles tightly). */
function serialise<T>(provider: ProviderId, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(provider) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    try { return await task() }
    finally { if (MIN_GAP_MS[provider]) await sleep(MIN_GAP_MS[provider]) }
  })
  queues.set(provider, next)
  return next
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  query?: Record<string, string | number | string[] | undefined>
  body?: unknown
  headers?: Record<string, string>
}

export function createClient(provider: ProviderId, baseURL: string, accessToken: () => Promise<string>, contentType = 'application/json') {
  return function request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    return serialise(provider, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          requestCounts[provider]++
          return await ofetch<T>(path, {
            baseURL: path.startsWith('http') ? undefined : baseURL,
            method: options.method ?? 'GET',
            query: options.query,
            body: options.body as Record<string, unknown> | undefined,
            headers: { Authorization: `Bearer ${await accessToken()}`, Accept: contentType, 'Content-Type': contentType, ...options.headers },
            retry: 0,
          })
        } catch (error) {
          if (!(error instanceof FetchError)) throw error
          const status = error.status ?? 0
          const text = typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? '')
          const label = `${provider} ${options.method ?? 'GET'} ${path.split('?')[0]}`
          const retryAfterHeader = Number(error.response?.headers.get('retry-after')) || null
          if (status === 429 && (text.includes('QUOTA_EXCEEDED') || (retryAfterHeader ?? 0) > LONG_WAIT_SECONDS)) {
            throw new QuotaError(provider, `${label} → 429 ${text.includes('QUOTA_EXCEEDED') ? 'QUOTA_EXCEEDED' : 'rate limited'} (Retry-After: ${retryAfterHeader ?? 'none'})`, retryAfterHeader)
          }
          if ((status === 429 || status >= 500) && attempt <= 3) {
            await sleep((retryAfterHeader ?? 2 ** attempt) * 1000)
            continue
          }
          throw new ProviderError(provider, status, `${label} → ${status}: ${text.slice(0, 300)}`)
        }
      }
    })
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
