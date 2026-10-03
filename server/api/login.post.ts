import { verifyAppPassword } from '../utils/password'

export default defineEventHandler(async (event) => {
  const { username, password } = await readBody<{ username?: string, password?: string }>(event)
  const expectedUser = process.env.APP_USERNAME
  const hash = process.env.APP_PASSWORD_HASH
  if (!expectedUser || !hash) throw createError({ statusCode: 500, statusMessage: 'APP_USERNAME and APP_PASSWORD_HASH must be set' })
  const ok = username === expectedUser && typeof password === 'string' && await verifyAppPassword(hash, password)
  if (!ok) throw createError({ statusCode: 401, statusMessage: 'Wrong username or password' })
  await setUserSession(event, { user: { username } })
  return { ok: true }
})
