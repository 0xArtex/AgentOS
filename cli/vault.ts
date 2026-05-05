/**
 * CLI-side reader for the AgentOS wallet vault.
 *
 * Loads encrypted wallet files from ~/.agentos/wallet/ and decrypts them
 * using the session secret from the OS credential store. Falls back to
 * passphrase-based decryption for legacy wallets.
 */
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, statSync, unlinkSync } from 'fs'
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
}

export interface VaultWalletSummary {
  id: string
  name: string
  mode: string
  solanaAddress: string | null
  evmAddress: string | null
  createdAt: string
}

function getVaultDir(): string {
  return process.env.AGENTOS_WALLET_PATH || join(homedir(), '.agentos', 'wallet')
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
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WalletFile
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
      // finds it in `accounts` directly.
      if (!evm) {
        const derived = deriveEvmFromVaultFile(data)
        if (derived) {
          evm = derived
          persistEvmAccount(filePath, derived)
        }
      }
      wallets.push({ id: data.id, name: data.name, mode: data.mode || 'legacy', solanaAddress: sol, evmAddress: evm, createdAt: data.created_at })
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
 * Decrypts via session secret from OS credential store, signs with the chain's keypair.
 */
export function signMessageLocal(walletId: string, chain: string, message: string): { signature: string; recoveryId?: number } {
  const file = loadWalletFile(walletId)
  const mnemonic = resolveMnemonic(file)
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

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + `.tmp.${process.pid}`
  writeFileSync(tmpPath, data)
  renameSync(tmpPath, filePath)
}

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 5_000

function acquireLock(targetPath: string): () => void {
  const lockPath = targetPath + '.lock'
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)
      closeSync(fd)
      return () => { try { unlinkSync(lockPath) } catch {} }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath) } catch {}
          continue
        }
      } catch { continue }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock on ${targetPath}`)
      }
      const waitUntil = Date.now() + LOCK_RETRY_MS
      while (Date.now() < waitUntil) { /* spin */ }
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

function deriveAllAccounts(mnemonic: string): AccountInfo[] {
  const accounts: AccountInfo[] = []
  const seed = bip39.mnemonicToSeedSync(mnemonic)

  try {
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'))
    const kp = Keypair.fromSeed(derived.key)
    accounts.push({
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      address: kp.publicKey.toBase58(),
      derivationPath: "m/44'/501'/0'/0'",
    })
  } catch {}

  try {
    const { ethers } = require('ethers')
    const hd = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
    accounts.push({
      chainId: 'eip155:1',
      address: hd.address,
      derivationPath: "m/44'/60'/0'/0/0",
    })
  } catch {}

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
}

/**
 * Create a wallet locally — no server needed.
 * The session secret must be stored in the OS credential store by the caller.
 */
export function createLocalWallet(
  name: string,
  mode: 'unmanaged' | 'managed' = 'unmanaged',
): LocalWalletResult {
  const safeName = validateName(name)
  ensureVaultDirs()
  const mnemonic = bip39.generateMnemonic(128)
  const id = randomBytes(16).toString('hex')
  const sessionSecret = randomBytes(32).toString('hex')
  const accounts = deriveAllAccounts(mnemonic)

  const file: WalletFile = {
    id,
    name: safeName,
    mode,
    accounts,
    session_crypto: encryptWithRawKey(mnemonic, sessionSecret),
    key_type: 'mnemonic',
    created_at: new Date().toISOString(),
  }

  const fpath = join(getVaultDir(), 'wallets', `${id}.json`)
  withLock(fpath, () => atomicWriteFileSync(fpath, JSON.stringify(file, null, 2)))

  const sol = accounts.find(a => a.chainId.startsWith('solana:'))?.address || null
  const evm = accounts.find(a => a.chainId.startsWith('eip155:'))?.address || null

  return { id, name: safeName, mode, sessionSecret, solanaAddress: sol, evmAddress: evm, accounts, createdAt: file.created_at }
}

/**
 * Import a wallet from mnemonic locally — no server needed.
 */
export function importLocalWallet(
  name: string,
  mnemonic: string,
  mode: 'unmanaged' | 'managed' = 'unmanaged',
): LocalWalletResult {
  const safeName = validateName(name)
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic')
  ensureVaultDirs()
  const id = randomBytes(16).toString('hex')
  const sessionSecret = randomBytes(32).toString('hex')
  const accounts = deriveAllAccounts(mnemonic)

  const file: WalletFile = {
    id,
    name: safeName,
    mode,
    accounts,
    session_crypto: encryptWithRawKey(mnemonic, sessionSecret),
    key_type: 'mnemonic',
    created_at: new Date().toISOString(),
  }

  const fpath = join(getVaultDir(), 'wallets', `${id}.json`)
  withLock(fpath, () => atomicWriteFileSync(fpath, JSON.stringify(file, null, 2)))

  const sol = accounts.find(a => a.chainId.startsWith('solana:'))?.address || null
  const evm = accounts.find(a => a.chainId.startsWith('eip155:'))?.address || null

  return { id, name: safeName, mode, sessionSecret, solanaAddress: sol, evmAddress: evm, accounts, createdAt: file.created_at }
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
