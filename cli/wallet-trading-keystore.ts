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
import { ethers } from 'ethers'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'fs'
import { dirname, join } from 'path'

import { TRADING_DIR } from './wallet-trading.js'
import { deleteSecret, retrieveSecret, storeSecret } from './credential-store.js'

// `cli/credential-store.ts` validates account names as hex (see `assertHex`),
// so we use the sha256 of a stable label as the cache key.
const CACHE_ACCOUNT = createHash('sha256').update('palmyr.trading.keystore.seed').digest('hex').slice(0, 32)

const KEYSTORE_FILE = join(TRADING_DIR, 'keystore.json')
const CACHE_META_FILE = join(TRADING_DIR, 'keystore-cache-meta.json')

// Phase 4c — cache TTL defaults. 24h is the sweet spot for "trading session
// length" while still forcing daily re-auth. Users can override per-unlock
// with --ttl, or set the cli config's `keystoreCacheTtlMs` for a project-wide
// default.
export const DEFAULT_KEYSTORE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
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
 *
 * Phase 4c — pairs the cached secret with a plaintext metadata file recording
 * `cachedAt` + `ttlMs`. `getCachedSeedHex()` enforces the TTL on every read:
 * if expired, the seed is wiped from the keychain and the function returns
 * null. Default TTL is 24h (`DEFAULT_KEYSTORE_CACHE_TTL_MS`); user can
 * override per-unlock via `--ttl <dur>` or globally via `keystoreCacheTtlMs`
 * in trading config.
 */
interface CacheMeta {
  cachedAt: string         // ISO 8601
  ttlMs: number            // hard deadline from cachedAt
}

function readCacheMeta(): CacheMeta | null {
  if (!existsSync(CACHE_META_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(CACHE_META_FILE, 'utf8')) as Partial<CacheMeta>
    if (typeof data.cachedAt !== 'string' || typeof data.ttlMs !== 'number') return null
    return { cachedAt: data.cachedAt, ttlMs: data.ttlMs }
  } catch {
    return null
  }
}

function writeCacheMeta(meta: CacheMeta) {
  if (!existsSync(dirname(CACHE_META_FILE))) {
    mkdirSync(dirname(CACHE_META_FILE), { recursive: true })
  }
  writeFileSync(CACHE_META_FILE, JSON.stringify(meta, null, 2))
}

function deleteCacheMeta() {
  if (existsSync(CACHE_META_FILE)) {
    try { unlinkSync(CACHE_META_FILE) } catch {}
  }
}

export function cacheSeedHex(seedHex: string, ttlMs: number = DEFAULT_KEYSTORE_CACHE_TTL_MS) {
  storeSecret(CACHE_ACCOUNT, seedHex)
  writeCacheMeta({
    cachedAt: new Date().toISOString(),
    ttlMs: Math.max(0, Math.floor(ttlMs)),
  })
}

/**
 * Returns the cached seed iff (a) keychain has it, AND (b) the TTL has not
 * elapsed since cachedAt. Expired caches are wiped on access — so a single
 * stale read is enough to auto-lock the keystore on the next command.
 *
 * Back-compat: caches written by Phase 4b (pre-TTL) have no meta file. We
 * treat "seed in keychain + no meta" as "trust on first use" and write a
 * default-TTL meta. That keeps existing daemons running through the upgrade
 * — they'll auto-lock 24h after the first post-upgrade invocation.
 */
export function getCachedSeedHex(): string | null {
  const seed = retrieveSecret(CACHE_ACCOUNT)
  if (!seed) return null
  const meta = readCacheMeta()
  if (!meta) {
    // Phase 4b cache — adopt with default TTL.
    writeCacheMeta({
      cachedAt: new Date().toISOString(),
      ttlMs: DEFAULT_KEYSTORE_CACHE_TTL_MS,
    })
    return seed
  }
  const deadline = new Date(meta.cachedAt).getTime() + meta.ttlMs
  if (Date.now() >= deadline) {
    // expired — wipe and signal locked
    clearCachedSeed()
    return null
  }
  return seed
}

export function clearCachedSeed() {
  deleteSecret(CACHE_ACCOUNT)
  deleteCacheMeta()
}

/**
 * Phase 4c — surface raw cache state (without TTL enforcement) so `status`
 * can show "expired" distinctly from "never unlocked".
 */
export interface CacheLockState {
  hasSecret: boolean
  meta: CacheMeta | null
  expired: boolean
  expiresAt: string | null
}

export function getCacheLockState(): CacheLockState {
  const hasSecret = retrieveSecret(CACHE_ACCOUNT) !== null
  const meta = readCacheMeta()
  if (!hasSecret || !meta) {
    return { hasSecret, meta, expired: !hasSecret, expiresAt: null }
  }
  const deadline = new Date(meta.cachedAt).getTime() + meta.ttlMs
  return {
    hasSecret,
    meta,
    expired: Date.now() >= deadline,
    expiresAt: new Date(deadline).toISOString(),
  }
}

export function isUnlocked(): boolean {
  return !!getCachedSeedHex()
}

function ensureKeystoreDir() {
  const dir = dirname(KEYSTORE_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Crash-safe write for keystore.json — the ONLY encrypted copy of the trading
 * mnemonic. A plain `writeFileSync` can truncate the file mid-write on a crash
 * or power loss, destroying the ciphertext and bricking every derived wallet.
 *
 * We write to a temp file in the same directory (so the final `rename` is a
 * same-filesystem atomic swap), fsync the bytes to disk, then rename over the
 * target. `rename` is atomic on POSIX and replaces an existing file on Windows,
 * so a reader/crash sees either the complete old file or the complete new one —
 * never a zero-byte or half-written keystore. The temp file is created 0600 and
 * cleaned up on any failure so we never leak the mnemonic ciphertext to a stray
 * world-readable file. Mirrors `atomicWriteFile` in cli/wallet-trading.ts (used
 * for position files) but adds fsync + restrictive perms given the stakes.
 */
function atomicWriteKeystore(target: string, content: string) {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base = target.split(/[\\/]/).pop()
  const tmp = join(dir, `.${base}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    // Flush the temp file's contents to stable storage before the rename so a
    // power loss right after the rename can't leave a metadata-only (empty) file.
    const fd = openSync(tmp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

// ───────── Public API ─────────

export interface InitKeystoreOpts {
  passphrase: string
  mnemonic?: string              // import an existing mnemonic; otherwise generate fresh
  count?: number                 // initial number of derived wallets, default 5
  /** Phase 4c — override default cache TTL on the auto-cache that runs after init. */
  cacheTtlMs?: number
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
  atomicWriteKeystore(KEYSTORE_FILE, JSON.stringify(file, null, 2))
  // Auto-cache the seed — user just authenticated, no point making them
  // unlock again on the next command in the same session.
  cacheSeedHex(seedHex, opts.cacheTtlMs ?? DEFAULT_KEYSTORE_CACHE_TTL_MS)
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
  /** Phase 4c — cache TTL state. */
  cache?: CacheLockState
}

export function getKeystoreStatus(): KeystoreStatus {
  const file = readKeystoreFile()
  return {
    exists: !!file,
    path: KEYSTORE_FILE,
    createdAt: file?.createdAt ?? null,
    walletCount: file?.addresses.length ?? 0,
    cache: getCacheLockState(),
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

/**
 * Phase 4c — unlock + cache with an explicit TTL. Convenience wrapper used by
 * the CLI's `trading-keystore unlock` command. Returns the cache deadline so
 * the caller can print "expires in N minutes".
 */
export function unlockAndCache(passphrase: string, ttlMs: number = DEFAULT_KEYSTORE_CACHE_TTL_MS): { seedHex: string; expiresAt: string } {
  const seedHex = unlockKeystore(passphrase)
  cacheSeedHex(seedHex, ttlMs)
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  return { seedHex, expiresAt }
}

/**
 * Phase 5a — derive an EVM wallet from the same seed at the standard BIP44
 * EVM path `m/44'/60'/<index>'/0/0`. Same auth fallback chain as the Solana
 * helpers. The returned wallet has no provider attached; caller must
 * `.connect(provider)` before signing.
 */
export function getKeystoreEvmWallet(index: number, passphrase?: string): ethers.Wallet {
  const file = readKeystoreFile()
  if (!file) {
    throw new Error('No trading keystore. Run `palmyr wallet trading-keystore init` first.')
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid wallet index: ${index}`)
  }
  const seedHex = resolveSeedHex(passphrase)
  const seed = ethers.getBytes('0x' + seedHex)
  const node = ethers.HDNodeWallet.fromSeed(seed)
  const derived = node.derivePath(`44'/60'/${index}'/0/0`)
  return new ethers.Wallet(derived.privateKey)
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

  atomicWriteKeystore(KEYSTORE_FILE, JSON.stringify(file, null, 2))
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
