/**
 * RFC 6238 TOTP code derivation. Pure Node crypto, no external deps.
 *
 * Secret is a base32-encoded string (RFC 4648) — the format X / Google Auth /
 * Authy exchange via QR codes. `code(secret)` returns the current 6-digit code
 * for the 30-second window.
 */
import { createHmac } from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  const bits: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`)
    for (let i = 4; i >= 0; i--) bits.push((idx >> i) & 1)
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    bytes.push(byte)
  }
  return Buffer.from(bytes)
}

export function code(secretBase32: string, timeMs: number = Date.now(), stepSec: number = 30, digits: number = 6): string {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(timeMs / 1000 / stepSec)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter), 0)
  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const value = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  )
  const mod = 10 ** digits
  return String(value % mod).padStart(digits, '0')
}

export function secondsUntilNextCode(timeMs: number = Date.now(), stepSec: number = 30): number {
  return stepSec - Math.floor(timeMs / 1000) % stepSec
}
