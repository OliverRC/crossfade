// APP_PASSWORD_HASH format: scrypt:<salt>:<key>, both base64url. Generate with `pnpm hash-password`.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export async function hashAppPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return `scrypt:${salt.toString('base64url')}:${(await derive(password, salt, 64)).toString('base64url')}`
}

export async function verifyAppPassword(hash: string, password: string): Promise<boolean> {
  const [scheme, salt, key] = hash.split(':')
  if (scheme !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64url')
  const actual = await derive(password, Buffer.from(salt, 'base64url'), expected.length)
  return timingSafeEqual(actual, expected)
}
