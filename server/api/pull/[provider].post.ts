import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { lockHolder } from '../../jobs/lock'
import { startPull } from '../../jobs/runner'
import { getAccount } from '../../utils/accounts'

/** Pull one service into main. Reads only; never writes to Spotify or Tidal. */
export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404, statusMessage: 'Unknown service' })
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw createError({ statusCode: 409, statusMessage: `Connect ${provider === 'spotify' ? 'Spotify' : 'Tidal'} first` })
  const runId = startPull(provider, 'manual')
  if (runId === null) throw createError({ statusCode: 409, statusMessage: lockHolder() === 'cleanup' ? 'A playlist cleanup is running' : 'A pull is already running' })
  return { runId }
})
