/**
 * CLI-side reader for the AgentOS wallet vault.
 *
 * Loads encrypted wallet files from ~/.agentos/wallet/, decrypts with
 * AGENTOS_WALLET_PASSWORD, and derives Solana/EVM keys. Vault file format
 * matches src/services/wallet-vault.ts so files are interchangeable.
 */
import { createDecipheriv, scryptSync } from 'crypto'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { Keypair } from '@solana/web3.js'

interface EncryptedBlob {
  iv: string
  salt: string
  ciphertext: string
  tag: string
}

interface WalletFile {
  agentos_version: number
  id: string
  name: string
  accounts: Array<{ chainId: string; address: string; derivationPath: string }>
  crypto: EncryptedBlob
  key_type: 'mnemonic' | 'private_key'
  created_at: string
}

export interface VaultWalletSummary {
  id: string
  name: string
  solanaAddress: string | null
  evmAddress: string | null
  createdAt: string
}

function getVaultDir(): string {
  return process.env.AGENTOS_WALLET_PATH || join(homedir(), '.agentos', 'wallet')
}

function decrypt(blob: EncryptedBlob, passphrase: string): string {
  const key = scryptSync(passphrase || 'default', Buffer.from(blob.salt, 'hex'), 32)
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
    if (data.id === nameOrId || data.name === nameOrId) return data
  }
  throw new Error(`Wallet "${nameOrId}" not found in vault at ${dir}`)
}

/** List all wallets in the local vault. */
export function listVaultWallets(): VaultWalletSummary[] {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WalletFile
      const sol = data.accounts.find(a => a.chainId.startsWith('solana:'))?.address || null
      const evm = data.accounts.find(a => a.chainId.startsWith('eip155:'))?.address || null
      return { id: data.id, name: data.name, solanaAddress: sol, evmAddress: evm, createdAt: data.created_at }
    })
}

/**
 * Get a raw Solana Keypair for a vault wallet. Requires AGENTOS_WALLET_PASSWORD
 * in the environment if the vault was created with one.
 */
export function getVaultSolanaKeypair(walletId: string): Keypair {
  const file = loadWalletFile(walletId)
  if (file.key_type !== 'mnemonic') throw new Error('Wallet was imported as a raw private key')
  const passphrase = process.env.AGENTOS_WALLET_PASSWORD || ''
  const mnemonic = decrypt(file.crypto, passphrase)
  const seed = bip39.mnemonicToSeedSync(mnemonic)
  const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'))
  return Keypair.fromSeed(derived.key)
}

/** Check if any vault wallets exist locally. */
export function hasVaultWallets(): boolean {
  const dir = join(getVaultDir(), 'wallets')
  if (!existsSync(dir)) return false
  return readdirSync(dir).some(f => f.endsWith('.json'))
}
