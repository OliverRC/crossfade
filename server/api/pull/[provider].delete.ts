import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { unqueuePull } from '../../jobs/runner'

/** Take a queued pull out of the queue. A pull already running is not stopped. */
export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404, statusMessage: 'Unknown service' })
  unqueuePull(provider)
  return { ok: true }
})
