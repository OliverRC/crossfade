import { beforeAll, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../server/utils/crypto'

describe('token encryption', () => {
  beforeAll(() => { process.env.TOKEN_ENCRYPTION_KEY = 'test-key-that-is-at-least-32-characters-long' })

  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('secret-token')
    expect(decrypt(a)).toBe('secret-token')
    expect(encrypt('secret-token')).not.toBe(a)
  })

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, data] = encrypt('secret-token').split('.')
    const flipped = data!.slice(0, -2) + (data!.endsWith('A') ? 'BB' : 'AA')
    expect(() => decrypt([v, iv, tag, flipped].join('.'))).toThrow()
  })
})

describe('app password hash', async () => {
  const { hashAppPassword, verifyAppPassword } = await import('../server/utils/password')
  it('verifies the right password only', async () => {
    const hash = await hashAppPassword('correct horse')
    expect(await verifyAppPassword(hash, 'correct horse')).toBe(true)
    expect(await verifyAppPassword(hash, 'wrong')).toBe(false)
    expect(await verifyAppPassword('garbage', 'correct horse')).toBe(false)
  })
})
