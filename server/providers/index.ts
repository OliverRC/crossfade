import type { ProviderId } from '../../shared/types'
import { getAccount, NeedsReconnectError } from '../utils/accounts'
import { createSpotify } from './spotify'
import { createTidal } from './tidal'
import type { MusicProvider } from './types'

export function getProvider(provider: ProviderId): MusicProvider {
  const account = getAccount(provider)
  if (!account || account.needsReconnect) throw new NeedsReconnectError(provider)
  return provider === 'spotify' ? createSpotify(account.providerUserId) : createTidal(account.country ?? 'US')
}
