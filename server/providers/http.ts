// Shared HTTP client for provider APIs: serialised per provider, retries 429 and 5xx honouring Retry-After.
import { FetchError, ofetch } from 'ofetch'
import type { ProviderId } from '../../shared/types'

export class ProviderError extends Error {
  constructor(readonly provider: ProviderId, readonly status: number, message: string, readonly quotaExceeded = false) {
    super(message)
  }
}

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
}

export function createClient(provider: ProviderId, baseURL: string, accessToken: () => Promise<string>, contentType = 'application/json') {
  return function request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    return serialise(provider, async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await ofetch<T>(path, {
            baseURL: path.startsWith('http') ? undefined : baseURL,
            method: options.method ?? 'GET',
            query: options.query,
            body: options.body as Record<string, unknown> | undefined,
            headers: { Authorization: `Bearer ${await accessToken()}`, Accept: contentType, 'Content-Type': contentType },
            retry: 0,
          })
        } catch (error) {
          if (!(error instanceof FetchError)) throw error
          const status = error.status ?? 0
          const text = typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? '')
          const quotaExceeded = status === 429 && text.includes('QUOTA_EXCEEDED')
          if ((status === 429 || status >= 500) && attempt <= 3 && !quotaExceeded) {
            const retryAfter = Number(error.response?.headers.get('retry-after')) || 2 ** attempt
            await sleep(retryAfter * 1000)
            continue
          }
          throw new ProviderError(provider, status, `${provider} ${options.method ?? 'GET'} ${path} → ${status}: ${text.slice(0, 300)}`, quotaExceeded)
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
