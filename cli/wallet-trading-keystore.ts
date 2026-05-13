/**
 * Trading keystore — Phase 4.
 *
 * Separate from the existing Palmyr vault (`cli/vault.ts`) on purpose: trading
 * wallets unlock often, sign many txs per session, and rotate; the custody
 * wallet stays in the original vault. The two share the same crypto recipe
 * (scrypt + AES-256-GCM) for consistency with `cli/vault.ts`.
 *
 * Storage: `~/.palmyr/trading/keystore.json` (overridable via the existing
 * `PALMYR_TRADING_PATH` env). One BIP39 mnemonic encrypted at rest; derived
 * Solana wallets at `m/44'/501'/<index>'/0'` (Phantom-compatible). Addresses
 * are stored in plaintext alongside the ciphertext so `list` / `status` work
 * without unlocking.
 *
 * Passphrase: Phase 4a reads from `PALMYR_TRADING_KEYSTORE_PASSPHRASE` env
 * var. Interactive prompt + OS-keychain session caching land in Phase 4b.
 */
import { Keypair } from '@solana/web3.js'
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import { TRADING_DIR } from './wallet-trading.js'
import { deleteSecret, retrieveSecret, storeSecret } from './credential-store.js'

const CACHE_ACCOUNT = 'trading-keystore-seed'

const KEYSTORE_FILE = join(TRADING_DIR, 'keystore.json')
const SCRYPT_KEYLEN = 32
const SCRYPT_N = 131_072         // 2^17 — Phantom-grade
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const DERIVATION = (index: number) => `m/44'/501'/${index}'/0'`

export interface KeystoreFile {
  version: 1
  kdf: 'scrypt'
  kdfParams: { N: number; r: number; p: number; keyLen: number }
  salt: string                   // hex
  cipher: 'aes-256-gcm'
  iv: string                     // hex
  tag: string                    // hex
  ciphertext: string             // hex — encrypted BIP39 mnemonic
  createdAt: string              // ISO 8601
  addresses: Array<{ index: number; address: string }>
}

// ───────── Internal crypto helpers ─────────

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
}

function encryptMnemonic(
  mnemonic: string,
  passphrase: string,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer; salt: Buffer } {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext, iv, tag, salt }
}

function decryptMnemonic(file: KeystoreFile, passphrase: string): string {
  const salt = Buffer.from(file.salt, 'hex')
  const iv = Buffer.from(file.iv, 'hex')
  const tag = Buffer.from(file.tag, 'hex')
  const ciphertext = Buffer.from(file.ciphertext, 'hex')
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    throw new Error('Trading keystore decryption failed — wrong passphrase, or the file was tampered with.')
  }
}

function keypairFromSeed(seedHex: string, index: number): Keypair {
  const { key } = derivePath(DERIVATION(index), seedHex)
  return Keypair.fromSeed(key)
}

// ───────── OS-keychain seed caching ─────────

/**
 * Stash the post-KDF seed hex in the OS credential store under a fixed account
 * name. Subsequent CLI invocations (and the daemon) can use the keystore
 * without re-entering the passphrase.
 *
 * Trade-off: the cached seed grants full keystore access. Anyone with
 * OS-level access to the user's keychain can drain every derived wallet — same
 * threat model as ssh-agent / password managers. Run `trading-keystore lock`
 * to clear the cache when stepping away.
 */
export function cacheSeedHex(seedHex: string) {
  storeSecret(CACHE_ACCOUNT, seedHex)
}

export function getCachedSeedHex(): string | null {
  return retrieveSecret(CACHE_ACCOUNT)
}

export function clearCachedSeed() {
  deleteSecret(CACHE_ACCOUNT)
}

export function isUnlocked(): boolean {
  return !!getCachedSeedHex()
}

function ensureKeystoreDir() {
  const dir = dirname(KEYSTORE_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ───────── Public API ─────────

export interface InitKeystoreOpts {
  passphrase: string
  mnemonic?: string              // import an existing mnemonic; otherwise generate fresh
  count?: number                 // initial number of derived wallets, default 5
}

export function keystoreExists(): boolean {
  return existsSync(KEYSTORE_FILE)
}

export function keystorePath(): string {
  return KEYSTORE_FILE
}

export function initKeystore(opts: InitKeystoreOpts): KeystoreFile {
  if (existsSync(KEYSTORE_FILE)) {
    throw new Error(
      `Trading keystore already exists at ${KEYSTORE_FILE}. Move or delete it before re-init (this is destructive).`,
    )
  }
  if (!opts.passphrase || opts.passphrase.length < 8) {
    throw new Error('Trading keystore passphrase must be at least 8 characters.')
  }

  const mnemonic = opts.mnemonic?.trim() ?? bip39.generateMnemonic(256) // 24 words
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic.')
  }

  const seedHex = bip39.mnemonicToSeedSync(mnemonic).toString('hex')
  const count = opts.count ?? 5

  const addresses: Array<{ index: number; address: string }> = []
  for (let i = 0; i < count; i++) {
    const kp = keypairFromSeed(seedHex, i)
    addresses.push({ index: i, address: kp.publicKey.toBase58() })
  }

  const enc = encryptMnemonic(mnemonic, opts.passphrase)
  const file: KeystoreFile = {
    version: 1,
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLen: SCRYPT_KEYLEN },
    salt: enc.salt.toString('hex'),
    cipher: 'aes-256-gcm',
    iv: enc.iv.toString('hex'),
    tag: enc.tag.toString('hex'),
    ciphertext: enc.ciphertext.toString('hex'),
    createdAt: new Date().toISOString(),
    addresses,
  }

  ensureKeystoreDir()
  writeFileSync(KEYSTORE_FILE, JSON.stringify(file, null, 2))
  // Auto-cache the seed — user just authenticated, no point making them
  // unlock again on the next command in the same session.
  cacheSeedHex(seedHex)
  return file
}

export function readKeystoreFile(): KeystoreFile | null {
  if (!existsSync(KEYSTORE_FILE)) return null
  try {
    return JSON.parse(readFileSync(KEYSTORE_FILE, 'utf8')) as KeystoreFile
  } catch {
    return null
  }
}

export function listKeystoreWallets(): Array<{ index: number; address: string }> {
  const file = readKeystoreFile()
  return file?.addresses ?? []
}

export interface KeystoreStatus {
  exists: boolean
  path: string
  createdAt: string | null
  walletCount: number
}

export function getKeystoreStatus(): KeystoreStatus {
  const file = readKeystoreFile()
  return {
    exists: !!file,
    path: KEYSTORE_FILE,
    createdAt: file?.createdAt ?? null,
    walletCount: file?.addresses.length ?? 0,
  }
}

/**
 * Resolve a seed hex for derivation. Tries (in order):
 *   1. Explicit `passphrase` arg → decrypt mnemonic → seed
 *   2. Cached seed in OS credential store
 *   3. Throw — caller's responsibility to prompt or surface the error
 *
 * Used by every derivation path (getKeystoreKeypair, deriveMoreWallets, etc.)
 * so all routes share one auth flow.
 */
function resolveSeedHex(passphrase?: string): string {
  if (passphrase) {
    const file = readKeystoreFile()
    if (!file) throw new Error('No trading keystore.')
    const mnemonic = decryptMnemonic(file, passphrase)
    return bip39.mnemonicToSeedSync(mnemonic).toString('hex')
  }
  const cached = getCachedSeedHex()
  if (cached) return cached
  throw new Error(
    'Trading keystore locked. Run `palmyr wallet trading-keystore unlock`, or set PALMYR_TRADING_KEYSTORE_PASSPHRASE.',
  )
}

export function getKeystoreKeypair(index: number, passphrase?: string): Keypair {
  const file = readKeystoreFile()
  if (!file) {
    throw new Error('No trading keystore. Run `palmyr wallet trading-keystore init` first.')
  }
  const entry = file.addresses.find((a) => a.index === index)
  if (!entry) {
    throw new Error(
      `No derived wallet at index ${index}. Run \`palmyr wallet trading-keystore derive --count N\` to extend.`,
    )
  }
  const seedHex = resolveSeedHex(passphrase)
  const kp = keypairFromSeed(seedHex, index)
  if (kp.publicKey.toBase58() !== entry.address) {
    throw new Error(
      `Keystore address mismatch at index ${index}: derived ${kp.publicKey.toBase58()} but stored ${entry.address}. Keystore may be corrupted.`,
    )
  }
  return kp
}

/**
 * Verify a passphrase by decrypting the mnemonic and return the seed hex.
 * Doesn't cache — that's the caller's choice.
 */
export function unlockKeystore(passphrase: string): string {
  const file = readKeystoreFile()
  if (!file) throw new Error('No trading keystore. Run `init` first.')
  const mnemonic = decryptMnemonic(file, passphrase)
  return bip39.mnemonicToSeedSync(mnemonic).toString('hex')
}

export function deriveMoreWallets(count: number, passphrase?: string): KeystoreFile {
  const file = readKeystoreFile()
  if (!file) throw new Error('No trading keystore. Run `init` first.')
  if (count <= 0) throw new Error('--count must be > 0')

  const seedHex = resolveSeedHex(passphrase)

  const existing = file.addresses.length
  for (let i = existing; i < existing + count; i++) {
    const kp = keypairFromSeed(seedHex, i)
    file.addresses.push({ index: i, address: kp.publicKey.toBase58() })
  }

  writeFileSync(KEYSTORE_FILE, JSON.stringify(file, null, 2))
  return file
}

/**
 * Export the mnemonic — REQUIRES the passphrase (no cache fallback).
 * Exporting the mnemonic is a destructive-disclosure action; we never let it
 * happen from cached state alone.
 */
export function exportMnemonic(passphrase: string): string {
  const file = readKeystoreFile()
  if (!file) throw new Error('No trading keystore.')
  return decryptMnemonic(file, passphrase)
}
