import { ofetch } from 'ofetch'
import { PROVIDERS, type ProviderId } from '../../../../shared/types'
import { exchangeCode, type TokenSet } from '../../../providers/oauth'
import { saveAccount } from '../../../utils/accounts'

async function profile(provider: ProviderId, tokens: TokenSet) {
  const headers = { Authorization: `Bearer ${tokens.accessToken}` }
  if (provider === 'spotify') {
    const me = await ofetch<any>('https://api.spotify.com/v1/me', { headers })
    return { providerUserId: String(me.id), country: null }
  }
  const me = await ofetch<any>('https://openapi.tidal.com/v2/users/me', { headers: { ...headers, Accept: 'application/vnd.api+json' } })
  return { providerUserId: String(me.data.id), country: me.data.attributes?.country ?? null }
}

export default defineEventHandler(async (event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404 })
  const fail = (message: string) => sendRedirect(event, `/connections?error=${encodeURIComponent(`${provider}: ${message}`)}`)

  const query = getQuery(event)
  const cookieName = `crossfade_oauth_${provider}`
  const saved = getCookie(event, cookieName)
  deleteCookie(event, cookieName, { path: `/auth/${provider}` })

  if (query.error) return fail(String(query.error_description ?? query.error))
  if (!saved) return fail('sign-in expired, try again')
  const { state, verifier } = JSON.parse(saved) as { state: string, verifier: string }
  if (query.state !== state || typeof query.code !== 'string') return fail('state mismatch, try again')

  try {
    const tokens = await exchangeCode(provider, query.code, verifier)
    saveAccount(provider, tokens, await profile(provider, tokens))
  } catch (error: any) {
    console.error(`[auth] ${provider} callback failed`, error?.data ?? error)
    return fail(error?.data?.error_description ?? error?.data?.errors?.[0]?.detail ?? error?.message ?? 'token exchange failed')
  }
  return sendRedirect(event, `/connections?connected=${provider}`)
})
