// Everything under /api and /auth needs the app login, except logging in itself.
export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0]!
  if (path === '/api/login' || path.startsWith('/api/_auth')) return
  if (path.startsWith('/api/') || path.startsWith('/auth/')) await requireUserSession(event)
})
