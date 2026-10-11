import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { deriveGCMKey } from '../crypto/crypto-primitives.js'
import { decryptV2 } from './message-crypto.js'

const shared = Buffer.alloc(32, 1)
const salt = Buffer.alloc(16, 2)
const nonce = Buffer.alloc(12, 3)
const aad = Buffer.from('aad')

function sealV2(plaintext: string): Buffer {
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveGCMKey(shared, salt),
    nonce,
  )
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

test('decryptV2 round-trips a well-formed payload', () => {
  expect(decryptV2(shared, salt, sealV2('{"text":"hi"}'), nonce, aad)).toBe(
    '{"text":"hi"}',
  )
})

test('decryptV2 rejects payloads too short to hold data plus a full tag', () => {
  // A short buffer used to become a truncated auth tag, which GCM accepts
  // unless the tag length is pinned.
  const sealed = sealV2('{"text":"hi"}')
  for (const short of [
    Buffer.alloc(0),
    sealed.subarray(sealed.length - 4),
    sealed.subarray(sealed.length - 16),
    // A 4-byte prefix of a genuine tag over empty data: accepted as a valid
    // (truncated) tag unless the tag length is pinned to 16.
    sealV2('').subarray(0, 4),
  ]) {
    expect(() => decryptV2(shared, salt, short, nonce, aad)).toThrow()
  }
})
