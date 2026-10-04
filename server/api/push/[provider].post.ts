import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { lockHolder } from '../../jobs/lock'
import { quotaBlockedUntil } from '../../jobs/quota'
import { startPush } from '../../jobs/runner'
import { createTidalWriter } from '../../providers/tidal'
import { getAccount } from '../../utils/accounts'
import { stagedChanges } from '../../utils/staging'

/** Push what is staged for one service: the only route that writes to Spotify or Tidal (docs/decisions/0007). */
export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404, statusMessage: 'Unknown service' })
  if (provider === 'spotify') throw createError({ statusCode: 409, statusMessage: 'Push to Spotify comes in the next step of M5' })
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw createError({ statusCode: 409, statusMessage: 'Connect Tidal first' })
  const scopes = account.scopes.split(' ')
  if (!scopes.includes('collection.write') || !scopes.includes('playlists.write')) throw createError({ statusCode: 409, statusMessage: 'Reconnect Tidal to grant write access to your collection and playlists' })
  const blocked = quotaBlockedUntil(provider)
  if (blocked) throw createError({ statusCode: 409, statusMessage: `Tidal is rate limited until ${blocked}` })
  if (!stagedChanges(provider).length) throw createError({ statusCode: 409, statusMessage: 'Nothing is staged for Tidal' })

  const runId = startPush(provider, createTidalWriter(account.country ?? 'US'))
  if (runId === null) throw createError({ statusCode: 409, statusMessage: lockHolder() === 'cleanup' ? 'A playlist cleanup is running' : 'A pull or push is already running' })
  return { runId }
})
