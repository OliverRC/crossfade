import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { pullOrQueue } from '../../jobs/runner'
import { getAccount } from '../../utils/accounts'

/** Pull one service into main, or queue it behind the running job. Reads only; never writes to Spotify or Tidal. */
export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404, statusMessage: 'Unknown service' })
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw createError({ statusCode: 409, statusMessage: `Connect ${provider === 'spotify' ? 'Spotify' : 'Tidal'} first` })
  const result = pullOrQueue(provider)
  if (result === null) throw createError({ statusCode: 409, statusMessage: 'This service is already pulling' })
  return result === 'queued' ? { queued: true } : { runId: result }
})
