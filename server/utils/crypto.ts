// Provider tokens at rest: AES-256-GCM, key derived from TOKEN_ENCRYPTION_KEY.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function key(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY
  if (!secret || secret.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must be set (at least 32 characters; try `openssl rand -base64 32`)')
  return createHash('sha256').update(secret).digest()
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised token format')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}
