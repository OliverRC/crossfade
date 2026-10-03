import { PROVIDERS, type ProviderId } from '../../../../shared/types'
import { authorizeUrl, createPkce } from '../../../providers/oauth'
import { providerCredentials } from '../../../utils/config'

export default defineEventHandler((event) => {
  const provider = getRouterParam(event, 'provider') as ProviderId
  if (!PROVIDERS.includes(provider)) throw createError({ statusCode: 404 })
  if (!providerCredentials(provider)) return sendRedirect(event, `/connections?error=${encodeURIComponent(`${provider.toUpperCase()}_CLIENT_ID is not set in .env`)}`)

  const { verifier, challenge, state } = createPkce()
  setCookie(event, `crossfade_oauth_${provider}`, JSON.stringify({ state, verifier }), {
    httpOnly: true, sameSite: 'lax', secure: !import.meta.dev, maxAge: 600, path: `/auth/${provider}`,
  })
  return sendRedirect(event, authorizeUrl(provider, state, challenge))
})
