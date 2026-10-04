import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { lockHolder } from '../../jobs/lock'
import { providerNames, quotaBlockedUntil } from '../../jobs/quota'
import { startPush } from '../../jobs/runner'
import { createSpotifyWriter } from '../../providers/spotify'
import { createTidalWriter } from '../../providers/tidal'
import type { PushWriter } from '../../providers/types'
import { getAccount } from '../../utils/accounts'
import { spotifyLookupBudget } from '../../utils/config'
import { stagedChanges } from '../../utils/staging'

/** Scopes a push needs on each service: library and playlist writes. */
const WRITE_SCOPES: Record<ProviderId, string[]> = {
  spotify: ['user-library-modify', 'playlist-modify-private', 'playlist-modify-public'],
  tidal: ['collection.write', 'playlists.write'],
}

/** Push what is staged for one service: the only route that writes to Spotify or Tidal (docs/decisions/0007). */
export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404, statusMessage: 'Unknown service' })
  const name = providerNames[provider]
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw createError({ statusCode: 409, statusMessage: `Connect ${name} first` })
  const scopes = account.scopes.split(' ')
  if (!WRITE_SCOPES[provider].every(s => scopes.includes(s))) throw createError({ statusCode: 409, statusMessage: `Reconnect ${name} to grant write access to your library and playlists` })
  const blocked = quotaBlockedUntil(provider)
  if (blocked) throw createError({ statusCode: 409, statusMessage: `${name} is rate limited until ${blocked}` })
  if (!stagedChanges(provider).length) throw createError({ statusCode: 409, statusMessage: `Nothing is staged for ${name}` })

  const writer: PushWriter = provider === 'spotify' ? createSpotifyWriter(spotifyLookupBudget()) : createTidalWriter(account.country ?? 'US')
  const runId = startPush(provider, writer)
  if (runId === null) throw createError({ statusCode: 409, statusMessage: lockHolder() === 'cleanup' ? 'A playlist cleanup is running' : 'A pull or push is already running' })
  return { runId }
})
