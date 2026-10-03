import { PROVIDERS, type ProviderId } from '../../../shared/types'
import { deleteAccount } from '../../utils/accounts'

export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404 })
  deleteAccount(provider)
  return { ok: true }
})
