import { PROVIDERS, type ConnectionView } from '../../../shared/types'
import { getAccount } from '../../utils/accounts'
import { providerCredentials, redirectUri } from '../../utils/config'

export default defineEventHandler((): ConnectionView[] => PROVIDERS.map((provider) => {
  const account = getAccount(provider)
  return {
    provider,
    configured: providerCredentials(provider) !== null,
    redirectUri: redirectUri(provider),
    connected: Boolean(account),
    providerUserId: account?.providerUserId ?? null,
    needsReconnect: account?.needsReconnect ?? false,
    scopes: account?.scopes.split(' ').filter(Boolean) ?? [],
  }
}))
