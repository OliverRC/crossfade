// Spotify only accepts 127.0.0.1 (not localhost) redirect URIs, and the OAuth callback must land on the
// same host as the login cookie. So in development, send localhost requests to the PUBLIC_BASE_URL host.
import { publicBaseUrl } from '../utils/config'

export default defineEventHandler((event) => {
  const base = new URL(publicBaseUrl())
  const host = getRequestHost(event, { xForwardedHost: false })
  if (base.hostname === '127.0.0.1' && host.split(':')[0] === 'localhost') {
    return sendRedirect(event, `${base.origin}${event.path}`, 302)
  }
})
