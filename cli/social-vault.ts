/**
 * Local encrypted vault for social account credentials (X, TikTok, etc.).
 *
 * Each account is stored as a JSON file in ~/.agentos/social/accounts/<id>.json
 * with public metadata (id, platform, username, status) alongside an
 * AES-256-GCM encrypted `cred_crypto` blob containing email + password +
 * TOTP seed + recovery codes.
 *
 * The decryption key is a per-account 32-byte session secret held in the OS
 * credential store. An attacker with only the file cannot decrypt it; an
 * attacker with only the credential store entry has no ciphertext to decrypt.
 */
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { storeSecret, retrieveSecret, deleteSecret } from './credential-store.js'

export type Platform = 'twitter' | 'tiktok'
export type AccountStatus = 'ready' | 'warming' | 'locked' | 'suspended' | 'dead'

interface EncryptedBlob {
  iv: string
  ciphertext: string
  tag: string
}

export interface SocialCredentials {
  /** What goes in the platform's login field — often an email, sometimes a username. */
  login?: string
  password: string
  /** The bind/recovery email that comes with the account. Used to receive verification codes. */
  email?: string
  /** Password for the bind email inbox, so automation can poll it for verification codes. */
  email_password?: string
  /** RFC 4648 base32 TOTP seed (when 2FA is enabled). */
  totp_seed?: string
  /** Recovery codes, if provided. */
  recovery_codes?: string[]
  /** Canonical profile URL from the seller (e.g. https://x.com/NatalieMcK61260). Optional, informational. */
  profile_url?: string
}

export interface SocialAccountFile {
  id: string                         // hex UUID — used as credential-store key
  platform: Platform
  username: string                   // current handle, source of truth
  previous_usernames: string[]
  cred_crypto: EncryptedBlob
  meta: {
    acquired_at: string
    acquisition_source: 'import' | 'accsmarket' | string
    status: AccountStatus
    age_years?: number
    original_signup_country?: string
    last_action_at: string | null
    notes?: string
  }
}

export interface SocialAccountSummary {
  id: string
  platform: Platform
  username: string
  status: AccountStatus
  acquired_at: string
  source: string
  last_action_at: string | null
}

function getSocialDir(): string {
  return process.env.AGENTOS_SOCIAL_PATH || join(homedir(), '.agentos', 'social')
}

function getAccountsDir(): string {
  return join(getSocialDir(), 'accounts')
}

function ensureDirs(): void {
  const root = getSocialDir()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  const accounts = getAccountsDir()
  if (!existsSync(accounts)) mkdirSync(accounts, { recursive: true })
  const sessions = join(root, 'sessions')
  if (!existsSync(sessions)) mkdirSync(sessions, { recursive: true })
  const history = join(root, 'history')
  if (!existsSync(history)) mkdirSync(history, { recursive: true })
}

function accountPath(id: string): string {
  return join(getAccountsDir(), `${id}.json`)
}

function newHexId(): string {
  // 16 hex chars — unique enough for local scope, short enough to not be ugly.
  return randomBytes(8).toString('hex')
}

function encrypt(plaintext: string, keyHex: string): EncryptedBlob {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

function decrypt(blob: EncryptedBlob, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'))
  let plaintext = decipher.update(blob.ciphertext, 'hex', 'utf8')
  plaintext += decipher.final('utf8')
  return plaintext
}

function readAllAccounts(): SocialAccountFile[] {
  ensureDirs()
  const dir = getAccountsDir()
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SocialAccountFile)
}

function findByUsername(platform: Platform, username: string): SocialAccountFile | undefined {
  return readAllAccounts().find(a => a.platform === platform && a.username === username)
}

function findById(id: string): SocialAccountFile | undefined {
  const fpath = accountPath(id)
  if (!existsSync(fpath)) return undefined
  return JSON.parse(readFileSync(fpath, 'utf8')) as SocialAccountFile
}

function writeAccount(account: SocialAccountFile): void {
  ensureDirs()
  writeFileSync(accountPath(account.id), JSON.stringify(account, null, 2))
}

// ─── Public API ────────────────────────────────────────────────────────────

export function importAccount(
  platform: Platform,
  username: string,
  credentials: SocialCredentials,
  opts: { source?: string; notes?: string } = {}
): SocialAccountSummary {
  if (findByUsername(platform, username)) {
    throw new Error(`${platform} account "${username}" already exists locally. Use 'remove' first if you want to re-import.`)
  }

  const id = newHexId()
  const sessionSecret = randomBytes(32).toString('hex')
  storeSecret(id, sessionSecret)

  const account: SocialAccountFile = {
    id,
    platform,
    username,
    previous_usernames: [],
    cred_crypto: encrypt(JSON.stringify(credentials), sessionSecret),
    meta: {
      acquired_at: new Date().toISOString(),
      acquisition_source: opts.source || 'import',
      status: 'ready',
      last_action_at: null,
      notes: opts.notes,
    },
  }
  writeAccount(account)

  return {
    id: account.id,
    platform: account.platform,
    username: account.username,
    status: account.meta.status,
    acquired_at: account.meta.acquired_at,
    source: account.meta.acquisition_source,
    last_action_at: account.meta.last_action_at,
  }
}

export function listAccounts(platform?: Platform): SocialAccountSummary[] {
  return readAllAccounts()
    .filter(a => !platform || a.platform === platform)
    .map(a => ({
      id: a.id,
      platform: a.platform,
      username: a.username,
      status: a.meta.status,
      acquired_at: a.meta.acquired_at,
      source: a.meta.acquisition_source,
      last_action_at: a.meta.last_action_at,
    }))
}

export function getAccount(platform: Platform, username: string): SocialAccountSummary | undefined {
  const acc = findByUsername(platform, username)
  if (!acc) return undefined
  return {
    id: acc.id,
    platform: acc.platform,
    username: acc.username,
    status: acc.meta.status,
    acquired_at: acc.meta.acquired_at,
    source: acc.meta.acquisition_source,
    last_action_at: acc.meta.last_action_at,
  }
}

export function removeAccount(platform: Platform, username: string): void {
  const acc = findByUsername(platform, username)
  if (!acc) throw new Error(`${platform} account "${username}" not found locally`)
  deleteSecret(acc.id)
  const fpath = accountPath(acc.id)
  if (existsSync(fpath)) unlinkSync(fpath)
}

export function renameAccount(platform: Platform, oldUsername: string, newUsername: string): SocialAccountSummary {
  const acc = findByUsername(platform, oldUsername)
  if (!acc) throw new Error(`${platform} account "${oldUsername}" not found locally`)
  if (findByUsername(platform, newUsername)) {
    throw new Error(`${platform} account "${newUsername}" already exists — can't rename into an existing slot`)
  }
  acc.previous_usernames.push(acc.username)
  acc.username = newUsername
  writeAccount(acc)
  return {
    id: acc.id,
    platform: acc.platform,
    username: acc.username,
    status: acc.meta.status,
    acquired_at: acc.meta.acquired_at,
    source: acc.meta.acquisition_source,
    last_action_at: acc.meta.last_action_at,
  }
}

/**
 * Decrypt and return credentials. Requires the session secret to be present
 * in the OS credential store — i.e. the account must have been created on
 * this machine. Use sparingly; prefer keeping creds out of memory.
 */
export function unlockCredentials(platform: Platform, username: string): SocialCredentials {
  const acc = findByUsername(platform, username)
  if (!acc) throw new Error(`${platform} account "${username}" not found locally`)
  const sessionSecret = retrieveSecret(acc.id)
  if (!sessionSecret) {
    throw new Error(
      `No session secret found for ${platform}/${username}. The account was likely imported on a different machine, ` +
      `or the OS credential store was wiped. Re-import the account to restore access.`
    )
  }
  const json = decrypt(acc.cred_crypto, sessionSecret)
  return JSON.parse(json) as SocialCredentials
}

/**
 * Update the status / notes / last_action_at fields on an account. Doesn't
 * touch the encrypted credentials.
 */
export function updateMeta(platform: Platform, username: string, patch: Partial<SocialAccountFile['meta']>): void {
  const acc = findByUsername(platform, username)
  if (!acc) throw new Error(`${platform} account "${username}" not found locally`)
  acc.meta = { ...acc.meta, ...patch }
  writeAccount(acc)
}
