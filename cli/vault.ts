/**
 * CLI-side reader for the Palmyr wallet vault.
 *
 * Loads encrypted wallet files from ~/.palmyr/wallet/ and decrypts them
 * using the session secret from the OS credential store. Falls back to
 * passphrase-based decryption for legacy wallets.
 */
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, writeSync, mkdirSync, renameSync, openSync, closeSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { Keypair } from '@solana/web3.js'
import { retrieveSecret } from './credential-store.js'

const require = createRequire(import.meta.url)

interface EncryptedBlob {
  iv: string
  salt: string
  ciphertext: string
  tag: string
}

interface WalletFile {
  id: string
  name: string
  mode?: 'unmanaged' | 'managed'
  accounts: Array<{ chainId: string; address: string; derivationPath: string }>
  session_crypto?: EncryptedBlob
  owner_crypto?: EncryptedBlob
  key_type: 'mnemonic' | 'private_key'
  agentos_version?: number
  created_at: string
  // Folder-like grouping. Set via `wallet create --tag X` or `wallet tag <id> <tag>`.
  // Tag deletion cascades to every wallet sharing the tag.
  tag?: string
  // Which chains the user asked to materialize. Absent on legacy wallets — the
  // listing path treats absence as "back-fill EVM if missing" so the historical
  // both-chains default doesn't regress. New wallets always write this field.
  chains?: string[]
}

export interface VaultWalletSummary {
  id: string
  name: string
  mode: string
  solanaAddress: string | null
  evmAddress: string | null
  createdAt: string
  tag: string | null
  chains: string[]
}

function getVaultDir(): string {
  return process.env.PALMYR_WALLET_PATH || join(homedir(), '.palmyr', 'wallet')
}

function decryptWithRawKey(blob: EncryptedBlob, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'))
  let decrypted = decipher.update(blob.ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

function decryptWithPassphrase(blob: EncryptedBlob, passphrase: string): string {
  if (!passphrase) throw new Error('Passphrase is required to decrypt wallet')
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'hex'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'))
  let decrypted = decipher.update(blob.ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

function loadWalletFile(nameOrId: string): WalletFile {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) throw new Error(`Vault directory not found: ${dir}`)

  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    // Guard the per-file parse so one truncated/corrupt wallet file can't make
    // EVERY vault operation (pay/sign/export/trade) throw. Mirrors the skip+warn
    // already used by listVaultWallets() and findWalletFile().
    let data: WalletFile
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WalletFile
    } catch (e: any) {
      console.warn(`[vault] skipping ${f}: ${e.message.split('\n')[0]}`)
      continue
    }
    if (data.id === nameOrId || data.name === nameOrId) {
      return data
    }
  }
  throw new Error(`Wallet "${nameOrId}" not found in vault at ${dir}`)
}

/**
 * Bidirectional integrity check: the mnemonic must derive exactly the accounts
 * stored in the file. Catches tampered addresses AND deleted/injected accounts.
 */
function verifyIntegrity(file: WalletFile, mnemonic: string): void {
  const derived = deriveAllAccounts(mnemonic)

  // Every stored account must be derivable at the same address
  for (const stored of file.accounts) {
    const match = derived.find(d => d.chainId === stored.chainId)
    if (!match) {
      throw new Error(
        `SECURITY: wallet file integrity check failed. ` +
        `Chain ${stored.chainId} present in file but not derivable from mnemonic. ` +
        `The wallet file may have been tampered with. Refusing to sign.`,
      )
    }
    if (match.address !== stored.address) {
      throw new Error(
        `SECURITY: wallet file integrity check failed. ` +
        `Stored address for ${stored.chainId} does not match derived. ` +
        `Expected ${match.address}, found ${stored.address}. ` +
        `The wallet file may have been tampered with. Refusing to sign.`,
      )
    }
  }

  // Note: we deliberately do NOT reverse-check that every derivable chain is
  // present in the file. Derivation is deterministic and public, so an attacker
  // cannot gain anything by removing a chain from the file. Enforcing reverse
  // equality only breaks wallets created before new chains were added to the
  // derivation set, which has real operational cost with zero security upside.
}

function resolveMnemonic(file: WalletFile, passphrase?: string): string {
  let mnemonic: string

  // Try session secret from OS credential store (new format)
  if (file.session_crypto) {
    const sessionSecret = retrieveSecret(file.id)
    if (sessionSecret) {
      mnemonic = decryptWithRawKey(file.session_crypto, sessionSecret)
      verifyIntegrity(file, mnemonic)
      return mnemonic
    }
  }

  // Fall back to passphrase (legacy v2 format)
  if (file.owner_crypto && passphrase) {
    mnemonic = decryptWithPassphrase(file.owner_crypto, passphrase)
    verifyIntegrity(file, mnemonic)
    return mnemonic
  }

  if (file.session_crypto) {
    throw new Error('No session secret found in OS credential store. Was this wallet created on this machine?')
  }
  throw new Error('No passphrase provided and no session secret available')
}

function keypairFromMnemonic(mnemonic: string): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic)
  const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'))
  return Keypair.fromSeed(derived.key)
}

/**
 * Derive the Base/EVM address for a wallet whose `accounts` array doesn't
 * include an `eip155:` entry yet (legacy wallets predate EVM-account storage).
 * Reuses the OS credential-store session secret — never prompts.
 *
 * Returns null if derivation isn't possible (raw private-key wallet, missing
 * session secret, or any decrypt failure). Caller treats that as "no Base
 * address to show" rather than an error.
 */
function deriveEvmFromVaultFile(data: WalletFile): string | null {
  if (data.key_type !== 'mnemonic') return null
  try {
    const mnemonic = resolveMnemonic(data)
    const { ethers } = require('ethers')
    const hd = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
    return hd.address as string
  } catch {
    return null
  }
}

/**
 * Backfill an `eip155:1` account entry into a legacy wallet's JSON file so
 * subsequent reads don't have to derive on the fly. Locked + atomic write so
 * concurrent CLI invocations don't corrupt the file.
 *
 * Failures here are non-fatal — the caller still has the derived address in
 * memory; this is purely a cache-on-disk optimization.
 */
function persistEvmAccount(filePath: string, address: string): void {
  const release = acquireLock(filePath)
  try {
    // Re-read inside the lock so we merge with whatever the file currently
    // holds — another writer (e.g. concurrent `wallet info`) may have already
    // backfilled and we don't want to clobber unrelated changes.
    const fresh = JSON.parse(readFileSync(filePath, 'utf8')) as WalletFile
    if (!Array.isArray(fresh.accounts)) return
    if (fresh.accounts.some(a => a.chainId?.startsWith('eip155:'))) return // already has one
    fresh.accounts.push({
      chainId: 'eip155:1',
      address,
      derivationPath: "m/44'/60'/0'/0/0",
    })
    atomicWriteFileSync(filePath, JSON.stringify(fresh, null, 2))
  } catch {
    // Swallow — backfill is best-effort. The lazy derive still works on next read.
  } finally {
    release()
  }
}

/**
 * List all wallets in the local vault.
 * Corrupted files are skipped with a warning — one bad file never breaks the whole listing.
 */
export function listVaultWallets(): VaultWalletSummary[] {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) return []

  const wallets: VaultWalletSummary[] = []
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const filePath = join(dir, f)
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8')) as WalletFile
      if (!data?.id || !Array.isArray(data.accounts)) {
        console.warn(`[vault] skipping ${f}: missing required fields`)
        continue
      }
      const sol = data.accounts.find(a => a.chainId?.startsWith('solana:'))?.address || null
      let evm = data.accounts.find(a => a.chainId?.startsWith('eip155:'))?.address || null
      // Legacy wallets predate EVM-account storage. Fall back to deriving
      // from the same mnemonic, then persist the result so the next read
      // finds it in `accounts` directly. Wallets with an explicit `chains`
      // array that excludes base opt out of this backfill — they were
      // intentionally created solana-only.
      const chainsField = Array.isArray(data.chains) ? data.chains : null
      const baseOptedOut = chainsField !== null && !chainsField.includes('base')
      if (!evm && !baseOptedOut) {
        const derived = deriveEvmFromVaultFile(data)
        if (derived) {
          evm = derived
          persistEvmAccount(filePath, derived)
        }
      }
      const chains = chainsField ?? [...(sol ? ['solana'] : []), ...(evm ? ['base'] : [])]
      wallets.push({
        id: data.id,
        name: data.name,
        mode: data.mode || 'legacy',
        solanaAddress: sol,
        evmAddress: evm,
        createdAt: data.created_at,
        tag: data.tag || null,
        chains,
      })
    } catch (e: any) {
      console.warn(`[vault] skipping ${f}: ${e.message.split('\n')[0]}`)
    }
  }
  return wallets
}

/**
 * Get a raw Solana Keypair for a vault wallet.
 * Tries OS credential store first, falls back to passphrase.
 */
export function getVaultSolanaKeypair(walletId: string, passphrase?: string): Keypair {
  const file = loadWalletFile(walletId)
  if (file.key_type !== 'mnemonic') throw new Error('Wallet was imported as a raw private key')
  const mnemonic = resolveMnemonic(file, passphrase)
  return keypairFromMnemonic(mnemonic)
}

/**
 * Get an ethers Wallet (secp256k1) for a vault wallet.
 * Used for signing EIP-3009 and EVM transactions.
 */
export function getVaultEvmWallet(walletId: string, passphrase?: string): any {
  const file = loadWalletFile(walletId)
  if (file.key_type !== 'mnemonic') throw new Error('Wallet was imported as a raw private key')
  const mnemonic = resolveMnemonic(file, passphrase)
  const { ethers } = require('ethers')
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
}

/**
 * Sign a message locally — no server needed.
 *
 * Decrypts via the standard auth chain: OS-keychain session secret first,
 * then falls back to `passphrase` (or `PALMYR_WALLET_PASSPHRASE` env when the
 * caller reads it through). Matches the read path used by `pay` / `export` /
 * `rekey` so a passphrase-backed wallet signs from any machine the env var
 * reaches.
 */
export function signMessageLocal(walletId: string, chain: string, message: string, passphrase?: string): { signature: string; recoveryId?: number } {
  const file = loadWalletFile(walletId)
  const mnemonic = resolveMnemonic(file, passphrase)
  const c = chain.toLowerCase()
  const msgBytes = Buffer.from(message, 'utf8')

  if (c === 'solana' || c.startsWith('solana:')) {
    const kp = keypairFromMnemonic(mnemonic)
    const nacl = require('tweetnacl')
    const sig = nacl.sign.detached(msgBytes, kp.secretKey)
    return { signature: Buffer.from(sig).toString('hex') }
  }

  if (c === 'evm' || c === 'base' || c === 'ethereum' || c.startsWith('eip155:')) {
    const { ethers } = require('ethers')
    const hd = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
    const sig = hd.signMessageSync(message)
    return { signature: sig.replace('0x', '') }
  }

  throw new Error(`Chain "${chain}" not supported for message signing`)
}

/** Check if any vault wallets exist locally. */
export function hasVaultWallets(): boolean {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) return false
  return readdirSync(dir).some(f => f.endsWith('.json'))
}

// ─── Local wallet creation (no server needed) ───

interface AccountInfo {
  chainId: string
  address: string
  derivationPath: string
}

const SAFE_NAME_RE = /^[a-zA-Z0-9 _\-\.]{1,128}$/

function validateName(name: string): string {
  if (!name || typeof name !== 'string') throw new Error('Wallet name is required')
  const trimmed = name.trim()
  if (!SAFE_NAME_RE.test(trimmed)) {
    throw new Error(
      `Invalid wallet name: must be 1-128 characters, alphanumeric/spaces/hyphens/underscores/dots only. Got: "${trimmed.slice(0, 30)}"`
    )
  }
  return trimmed
}

const SAFE_TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9\-\._]{0,63}$/

export function validateTag(tag: string): string {
  if (!tag || typeof tag !== 'string') throw new Error('Tag is required')
  const trimmed = tag.trim()
  if (!SAFE_TAG_RE.test(trimmed)) {
    throw new Error(
      `Invalid tag: must be 1-64 chars, alphanumeric/hyphens/dots/underscores, must start with alphanumeric. Got: "${trimmed.slice(0, 30)}"`
    )
  }
  return trimmed
}

export type ChainName = 'solana' | 'base'

export function normalizeChains(chains: string[] | undefined): ChainName[] {
  if (!chains || chains.length === 0) return ['solana', 'base']
  const out = new Set<ChainName>()
  for (const c of chains) {
    const lc = c.toLowerCase()
    if (lc === 'solana') out.add('solana')
    else if (lc === 'base' || lc === 'evm' || lc === 'ethereum') out.add('base')
    else throw new Error(`Unsupported chain: ${c}. Try: solana, base`)
  }
  if (out.size === 0) throw new Error('At least one chain is required')
  return Array.from(out)
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + `.tmp.${process.pid}`
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, filePath)
}

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5_000

/**
 * Synchronous sleep that yields the CPU instead of spinning. `acquireLock` and
 * `withLock` are synchronous (every caller — createLocalWallet, tagWallet,
 * rekeyWallet, … — is sync), so we can't `await` a timer without breaking those
 * signatures. `Atomics.wait` on a throwaway SharedArrayBuffer parks the thread
 * for `ms` without burning a core (unlike the old `while (Date.now() < …) {}`),
 * and works identically on Windows + POSIX. Falls back to a bounded spin only if
 * SharedArrayBuffer is unavailable (it isn't in any supported Node).
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* fallback spin */ }
  }
}

function acquireLock(targetPath: string): () => void {
  const lockPath = targetPath + '.lock'
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      // Exclusive create — only one process/wins per round.
      const fd = openSync(lockPath, 'wx')
      try { writeSync(fd, `${process.pid}\n${Date.now()}`) } finally { closeSync(fd) }
      return () => { try { unlinkSync(lockPath) } catch {} }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      // A lock exists. If it's verifiably stale, try to take it over WITHOUT a
      // racy delete-then-recreate. Two waiters that both judged the old lock
      // stale must not both unlink it (the second would delete the winner's
      // fresh lock). Instead we atomically rename the stale file to a private
      // name: renameSync of a specific path is atomic, so exactly one waiter
      // "steals" it; the others get ENOENT and fall through to retry openSync,
      // where they'll see the winner's now-fresh lock and wait normally.
      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const stealPath = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
          try {
            renameSync(lockPath, stealPath)
            // We won the steal. Drop the stale file and loop to re-create.
            try { unlinkSync(stealPath) } catch {}
          } catch {
            // Lost the steal (another waiter renamed it first, or the holder
            // released it). Either way the path is no longer ours to remove.
          }
          continue
        }
      } catch {
        // statSync failed (lock vanished between openSync and statSync) — retry.
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${targetPath}`)
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
}

function withLock<T>(targetPath: string, fn: () => T): T {
  const release = acquireLock(targetPath)
  try { return fn() }
  finally { release() }
}

function ensureVaultDirs(): void {
  const base = getVaultDir()
  for (const sub of ['wallets', 'keys', 'policies', 'spends']) {
    const p = join(base, sub)
    if (!existsSync(p)) mkdirSync(p, { recursive: true })
  }
}

function encryptWithRawKey(plaintext: string, keyHex: string): EncryptedBlob {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const salt = randomBytes(32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    ciphertext: encrypted,
    tag: cipher.getAuthTag().toString('hex'),
  }
}

const MIN_PASSPHRASE_LEN = 8

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`)
  }
}

function encryptWithPassphrase(plaintext: string, passphrase: string): EncryptedBlob {
  assertPassphrase(passphrase)
  const iv = randomBytes(12)
  const salt = randomBytes(32)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    ciphertext: encrypted,
    tag: cipher.getAuthTag().toString('hex'),
  }
}

/**
 * Distinguish "ethers module can't even load" (missing dependency, broken
 * install) from "ethers loaded but threw mid-derivation" (genuinely odd
 * input). The former is an environment problem; the latter is a real
 * derivation failure. Callers — especially the integrity check — must NOT
 * treat them the same: missing-ethers cascading into "wallet tampered" was
 * the false-positive in the user report.
 */
function loadEthers(): typeof import('ethers') | { __loadError: Error } {
  try {
    return require('ethers')
  } catch (e: any) {
    return { __loadError: e instanceof Error ? e : new Error(String(e)) }
  }
}

function deriveAllAccounts(mnemonic: string, chains: ChainName[] = ['solana', 'base']): AccountInfo[] {
  const accounts: AccountInfo[] = []
  const seed = bip39.mnemonicToSeedSync(mnemonic)

  if (chains.includes('solana')) {
    try {
      const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'))
      const kp = Keypair.fromSeed(derived.key)
      accounts.push({
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        address: kp.publicKey.toBase58(),
        derivationPath: "m/44'/501'/0'/0'",
      })
    } catch {}
  }

  if (chains.includes('base')) {
    // ethers MUST be present (it's a declared dependency). If `require('ethers')`
    // throws, that's an environment problem — surface it loudly rather than
    // silently producing a partial account list. A partial list cascades into
    // verifyIntegrity()'s "Chain eip155:1 present in file but not derivable
    // from mnemonic" error, which gets reported as `SECURITY: wallet file
    // integrity check failed` and makes the user think their wallet was
    // tampered with. (Issue: 2026-05-05 user feedback after upgrade from
    // 0.7.17 → 0.7.20.)
    const ethersMod: any = loadEthers()
    if (ethersMod.__loadError) {
      throw new Error(
        `Could not load 'ethers'. Reinstall the CLI: 'npm i -g @palmyr/cli@latest'. ` +
        `Underlying error: ${ethersMod.__loadError.message}`
      )
    }
    try {
      const hd = ethersMod.ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
      accounts.push({
        chainId: 'eip155:1',
        address: hd.address,
        derivationPath: "m/44'/60'/0'/0/0",
      })
    } catch (e: any) {
      // ethers loaded but derivation threw. Truly anomalous — re-raise so the
      // integrity check sees a hard failure rather than a missing-account
      // false-positive.
      throw new Error(`EVM (eip155:1) account derivation failed: ${e?.message || e}`)
    }
  }

  return accounts
}

export interface LocalWalletResult {
  id: string
  name: string
  mode: 'unmanaged' | 'managed'
  sessionSecret: string
  solanaAddress: string | null
  evmAddress: string | null
  accounts: AccountInfo[]
  createdAt: string
  tag: string | null
  chains: ChainName[]
}

export interface CreateWalletOpts {
  tag?: string
  chains?: ChainName[]
  /**
   * If set, also seal the mnemonic with a scrypt-derived key from this
   * passphrase. Survives OS-keychain loss (different user, fresh OS,
   * headless box) — the passphrase becomes a durable fallback that
   * `PALMYR_WALLET_PASSPHRASE` / `--passphrase` can present at decrypt time.
   * Without this, the wallet is session-only and lives or dies with the
   * OS credential store on the machine where it was created.
   */
  passphrase?: string
}

function buildWallet(
  name: string,
  mode: 'unmanaged' | 'managed',
  mnemonic: string,
  opts: CreateWalletOpts,
): { file: WalletFile; result: LocalWalletResult } {
  const safeName = validateName(name)
  const safeTag = opts.tag === undefined ? undefined : validateTag(opts.tag)
  const chains = normalizeChains(opts.chains)
  const id = randomBytes(16).toString('hex')
  const sessionSecret = randomBytes(32).toString('hex')
  const accounts = deriveAllAccounts(mnemonic, chains)

  const file: WalletFile = {
    id,
    name: safeName,
    mode,
    accounts,
    session_crypto: encryptWithRawKey(mnemonic, sessionSecret),
    ...(opts.passphrase ? { owner_crypto: encryptWithPassphrase(mnemonic, opts.passphrase) } : {}),
    key_type: 'mnemonic',
    created_at: new Date().toISOString(),
    chains,
    ...(safeTag ? { tag: safeTag } : {}),
  }

  const sol = accounts.find(a => a.chainId.startsWith('solana:'))?.address || null
  const evm = accounts.find(a => a.chainId.startsWith('eip155:'))?.address || null

  const result: LocalWalletResult = {
    id,
    name: safeName,
    mode,
    sessionSecret,
    solanaAddress: sol,
    evmAddress: evm,
    accounts,
    createdAt: file.created_at,
    tag: safeTag ?? null,
    chains,
  }
  return { file, result }
}

/**
 * Create a wallet locally — no server needed.
 * The session secret must be stored in the OS credential store by the caller.
 */
export function createLocalWallet(
  name: string,
  mode: 'unmanaged' | 'managed' = 'unmanaged',
  opts: CreateWalletOpts = {},
): LocalWalletResult {
  ensureVaultDirs()
  const mnemonic = bip39.generateMnemonic(128)
  const { file, result } = buildWallet(name, mode, mnemonic, opts)
  const fpath = join(getVaultDir(), 'wallets', `${file.id}.json`)
  withLock(fpath, () => atomicWriteFileSync(fpath, JSON.stringify(file, null, 2)))
  return result
}

/**
 * Import a wallet from mnemonic locally — no server needed.
 */
export function importLocalWallet(
  name: string,
  mnemonic: string,
  mode: 'unmanaged' | 'managed' = 'unmanaged',
  opts: CreateWalletOpts = {},
): LocalWalletResult {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic')
  ensureVaultDirs()
  const { file, result } = buildWallet(name, mode, mnemonic, opts)
  const fpath = join(getVaultDir(), 'wallets', `${file.id}.json`)
  withLock(fpath, () => atomicWriteFileSync(fpath, JSON.stringify(file, null, 2)))
  return result
}

/**
 * Bulk-create N wallets sharing one tag. Caller is responsible for storing
 * `sessionSecret` for every returned wallet in the OS credential store —
 * `storeSecretsBatch` exists precisely so this can be one DPAPI call on Windows.
 *
 * Names are `${prefix}-{padded-index}` starting at 1. Throws up front if any
 * generated name would collide with an existing vault wallet so we never
 * write a partial batch (the loop is otherwise transactional file-by-file
 * but we'd rather fail before key material exists on disk than mid-flight).
 */
export function createLocalWalletsBatch(
  prefix: string,
  count: number,
  mode: 'unmanaged' | 'managed' = 'unmanaged',
  opts: CreateWalletOpts = {},
): LocalWalletResult[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer')
  if (count > 500) throw new Error('count must be ≤ 500 per call')
  const safePrefix = validateName(prefix)
  ensureVaultDirs()

  const width = String(count).length
  const names: string[] = []
  for (let i = 1; i <= count; i++) names.push(`${safePrefix}-${String(i).padStart(width, '0')}`)

  // Collision check against existing vault wallets — fail before writing anything.
  const existing = new Set(listVaultWallets().map(w => w.name))
  const collisions = names.filter(n => existing.has(n))
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 5).join(', ')
    const more = collisions.length > 5 ? `, +${collisions.length - 5} more` : ''
    throw new Error(`Name collisions in vault: ${shown}${more}. Pick a different --name-prefix.`)
  }

  const dir = join(getVaultDir(), 'wallets')
  const results: LocalWalletResult[] = []
  for (let i = 0; i < count; i++) {
    const mnemonic = bip39.generateMnemonic(128)
    const { file, result } = buildWallet(names[i], mode, mnemonic, opts)
    const fpath = join(dir, `${file.id}.json`)
    withLock(fpath, () => atomicWriteFileSync(fpath, JSON.stringify(file, null, 2)))
    results.push(result)
  }
  return results
}

function findWalletFile(walletId: string): { path: string; data: WalletFile } | null {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) return null
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const fpath = join(dir, f)
    try {
      const data = JSON.parse(readFileSync(fpath, 'utf8')) as WalletFile
      if (data.id === walletId || data.name === walletId) return { path: fpath, data }
    } catch {}
  }
  return null
}

/**
 * Delete a wallet's JSON file from the vault. Returns the wallet id+name so
 * the caller can also clear the OS credential store secret keyed by id.
 */
export function deleteLocalWallet(walletId: string): { id: string; name: string } {
  const hit = findWalletFile(walletId)
  if (!hit) throw new Error(`Wallet "${walletId}" not found`)
  withLock(hit.path, () => { try { unlinkSync(hit.path) } catch {} })
  return { id: hit.data.id, name: hit.data.name }
}

/**
 * Assign, change, or clear a wallet's tag. Pass `null` to remove the tag.
 */
export function tagWallet(walletId: string, tag: string | null): { id: string; name: string; tag: string | null } {
  const hit = findWalletFile(walletId)
  if (!hit) throw new Error(`Wallet "${walletId}" not found`)
  withLock(hit.path, () => {
    // Re-read inside the lock to merge with any concurrent backfill (e.g. EVM
    // backfill from listVaultWallets).
    const fresh = JSON.parse(readFileSync(hit.path, 'utf8')) as WalletFile
    if (tag === null) {
      delete (fresh as any).tag
    } else {
      fresh.tag = validateTag(tag)
    }
    atomicWriteFileSync(hit.path, JSON.stringify(fresh, null, 2))
  })
  return { id: hit.data.id, name: hit.data.name, tag: tag === null ? null : validateTag(tag) }
}

export interface TagSummary {
  name: string
  count: number
  chains: string[]
  firstCreatedAt: string
  lastCreatedAt: string
}

export function listTags(): TagSummary[] {
  const wallets = listVaultWallets()
  const byTag = new Map<string, VaultWalletSummary[]>()
  for (const w of wallets) {
    if (!w.tag) continue
    if (!byTag.has(w.tag)) byTag.set(w.tag, [])
    byTag.get(w.tag)!.push(w)
  }
  const tags: TagSummary[] = []
  for (const [name, ws] of byTag) {
    const chainsSet = new Set<string>()
    for (const w of ws) for (const c of w.chains) chainsSet.add(c)
    const sortedDates = ws.map(w => w.createdAt).sort()
    tags.push({
      name,
      count: ws.length,
      chains: Array.from(chainsSet).sort(),
      firstCreatedAt: sortedDates[0],
      lastCreatedAt: sortedDates[sortedDates.length - 1],
    })
  }
  tags.sort((a, b) => a.name.localeCompare(b.name))
  return tags
}

export function walletsByTag(tag: string): VaultWalletSummary[] {
  const validated = validateTag(tag)
  return listVaultWallets().filter(w => w.tag === validated)
}

/**
 * Export the mnemonic for a wallet. Requires the session secret
 * (from OS credential store). This is the single decryption path —
 * never reimplement decryption elsewhere.
 */
export function exportMnemonic(walletId: string): string {
  const file = loadWalletFile(walletId)
  return resolveMnemonic(file)
}

/**
 * True iff the wallet has a passphrase-encrypted blob — i.e. survives
 * OS-keychain loss with the right `PALMYR_WALLET_PASSPHRASE`.
 */
export function hasPassphraseFallback(walletId: string): boolean {
  return !!loadWalletFile(walletId).owner_crypto
}

/**
 * Add or rotate the passphrase-fallback blob on an existing wallet.
 *
 * The mnemonic is resolved via the standard auth chain (session secret →
 * existing passphrase), then re-encrypted with `newPassphrase` and the
 * `owner_crypto` blob is written back to the file atomically.
 *
 * Throws if the wallet can't be decrypted right now — there's no way to
 * add a fallback to a wallet whose key material we can't access.
 *
 * Use case: a legacy session-only wallet (`wallet create` pre-1.8.3, or
 * post-1.8.3 with explicit `--session-only`) needs durable recovery on a
 * new box. Run `wallet rekey <id> --passphrase <phrase>` on the ORIGINAL
 * machine while the session secret is still resolvable, then copy the
 * updated wallet JSON elsewhere and set `PALMYR_WALLET_PASSPHRASE` there.
 */
export function rekeyWallet(walletId: string, newPassphrase: string, currentPassphrase?: string): { id: string; name: string; rotated: boolean } {
  assertPassphrase(newPassphrase)
  const hit = findWalletFile(walletId)
  if (!hit) throw new Error(`Wallet "${walletId}" not found`)
  if (hit.data.key_type !== 'mnemonic') throw new Error('Rekey only supports mnemonic wallets')
  const mnemonic = resolveMnemonic(hit.data, currentPassphrase)
  const rotated = !!hit.data.owner_crypto
  withLock(hit.path, () => {
    const fresh = JSON.parse(readFileSync(hit.path, 'utf8')) as WalletFile
    fresh.owner_crypto = encryptWithPassphrase(mnemonic, newPassphrase)
    atomicWriteFileSync(hit.path, JSON.stringify(fresh, null, 2))
  })
  return { id: hit.data.id, name: hit.data.name, rotated }
}
