/**
 * Local encrypted vault for social account credentials (X, TikTok, etc.).
 *
 * Each account is stored as a JSON file in ~/.palmyr/social/accounts/<id>.json
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
  /** Canonical profile URL from the seller. Optional, informational. */
  profile_url?: string
  /** X session cookie — 40-char hex. If present, skip form login entirely. */
  auth_token?: string
  /** X CSRF cookie — 160-char hex. Paired with auth_token. */
  ct0?: string
  /** TikTok main auth cookie (hex). Required for TikTok cookie-injection login. */
  tiktok_sessionid?: string
  /** TikTok CSRF token cookie. */
  tiktok_csrf?: string
  /** TikTok device fingerprint cookie — preserves IP/device consistency. */
  tiktok_webid?: string
}

export interface SocialAccountFile {
  id: string                         // hex UUID — used as credential-store key
  platform: Platform
  username: string                   // current handle, source of truth
  previous_usernames: string[]
  cred_crypto: EncryptedBlob
  /**
   * Portable IPRoyal sticky-session key. Set when the account was seasoned
   * server-side (e.g. pool accounts, where the first login happened before
   * the buyer's vault existed). When present, every server op pins the
   * residential IP to this key rather than the local `id` — so the buyer
   * inherits the exact same IP the admin seasoned.
   */
  proxy_session_id?: string
  /**
   * ISO-3166 alpha-2 country code (lowercase). Drives the proxy exit country
   * AND the browser locale/timezone when the server opens a session for this
   * account. Stored at the top level (not in the encrypted credentials) so
   * the server can read it without decrypting the vault blob.
   */
  country?: string
  meta: {
    acquired_at: string
    acquisition_source: 'import' | 'accsmarket' | 'pool' | string
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
  proxy_session_id?: string
  country?: string
}

function getSocialDir(): string {
  return process.env.PALMYR_SOCIAL_PATH || join(homedir(), '.palmyr', 'social')
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
  // 0o600 to match saveSession — the account blob carries the AES-GCM
  // cred_crypto ciphertext plus username/proxy metadata; don't leave it
  // world-readable.
  writeFileSync(accountPath(account.id), JSON.stringify(account, null, 2), { mode: 0o600 })
}

// ─── Public API ────────────────────────────────────────────────────────────

export function importAccount(
  platform: Platform,
  username: string,
  credentials: SocialCredentials,
  opts: { source?: string; notes?: string; proxy_session_id?: string; country?: string } = {}
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
    proxy_session_id: opts.proxy_session_id,
    country: opts.country ? opts.country.toLowerCase() : undefined,
    meta: {
      acquired_at: new Date().toISOString(),
      acquisition_source: opts.source || 'import',
      status: 'ready',
      last_action_at: null,
      notes: opts.notes,
    },
  }
  writeAccount(account)

  return summarise(account)
}

function summarise(acc: SocialAccountFile): SocialAccountSummary {
  return {
    id: acc.id,
    platform: acc.platform,
    username: acc.username,
    status: acc.meta.status,
    acquired_at: acc.meta.acquired_at,
    source: acc.meta.acquisition_source,
    last_action_at: acc.meta.last_action_at,
    proxy_session_id: acc.proxy_session_id,
    country: acc.country,
  }
}

export function listAccounts(platform?: Platform): SocialAccountSummary[] {
  return readAllAccounts()
    .filter(a => !platform || a.platform === platform)
    .map(summarise)
}

export function getAccount(platform: Platform, username: string): SocialAccountSummary | undefined {
  const acc = findByUsername(platform, username)
  if (!acc) return undefined
  return summarise(acc)
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
  return summarise(acc)
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
 * Replace the stored credentials for an existing account, preserving id,
 * proxy_session_id, country, and meta. Re-encrypts with the existing
 * session secret. Used after a server-side password rotation (e.g.
 * `palmyr twitter unshare … --rotate`) so the local vault stays in sync
 * with the rotated credentials on X.
 */
export function replaceCredentials(
  platform: Platform,
  username: string,
  newCredentials: SocialCredentials
): SocialAccountSummary {
  const acc = findByUsername(platform, username)
  if (!acc) throw new Error(`${platform} account "${username}" not found locally`)
  const sessionSecret = retrieveSecret(acc.id)
  if (!sessionSecret) {
    throw new Error(
      `No session secret found for ${platform}/${username}. ` +
      `Cannot replace credentials without it — re-import the account first.`
    )
  }
  acc.cred_crypto = encrypt(JSON.stringify(newCredentials), sessionSecret)
  writeAccount(acc)
  return summarise(acc)
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

/**
 * Return the proxy_session_id for an account, if any. Server ops include
 * this so the residential IP lineage is preserved (essential for pool
 * accounts where the admin seasoned the session from a specific IP).
 */
export function getProxySessionId(platform: Platform, username: string): string | undefined {
  return findByUsername(platform, username)?.proxy_session_id
}

/** Return the stored ISO country code for an account (lowercase), if any. */
export function getCountry(platform: Platform, username: string): string | undefined {
  return findByUsername(platform, username)?.country
}

// ─── Session cache (cookies from login) ─────────────────────────────────

export interface SocialSession {
  account_id: string
  platform: Platform
  cookies: any[]
  captured_at: string
}

interface EncryptedSessionFile {
  account_id: string
  platform: Platform
  captured_at: string
  cookies_crypto: EncryptedBlob
}

function sessionPath(accountId: string): string {
  return join(getSocialDir(), 'sessions', `${accountId}.sess`)
}

/**
 * Persist a login session. Cookies are AES-GCM encrypted with the same per-
 * account session secret that protects credentials — an attacker with only
 * read access to ~/.palmyr/social/sessions/ gets ciphertext, not cookies.
 */
export function saveSession(accountId: string, platform: Platform, cookies: any[]): SocialSession {
  ensureDirs()
  const sessionSecret = retrieveSecret(accountId)
  if (!sessionSecret) {
    throw new Error(
      `Cannot encrypt session for ${accountId}: no session secret in the OS credential store. ` +
      `Was the account imported on this machine?`
    )
  }
  const capturedAt = new Date().toISOString()
  const payload: EncryptedSessionFile = {
    account_id: accountId,
    platform,
    captured_at: capturedAt,
    cookies_crypto: encrypt(JSON.stringify(cookies), sessionSecret),
  }
  writeFileSync(sessionPath(accountId), JSON.stringify(payload, null, 2), { mode: 0o600 })
  return { account_id: accountId, platform, cookies, captured_at: capturedAt }
}

export function loadSession(accountId: string): SocialSession | undefined {
  const fpath = sessionPath(accountId)
  if (!existsSync(fpath)) return undefined
  const raw = JSON.parse(readFileSync(fpath, 'utf8')) as EncryptedSessionFile | SocialSession

  // Legacy (plaintext) sessions from before session encryption existed — migrate
  // by re-saving encrypted when possible. Return as-is if the secret is missing.
  if ((raw as SocialSession).cookies && Array.isArray((raw as SocialSession).cookies)) {
    const legacy = raw as SocialSession
    try { saveSession(accountId, legacy.platform, legacy.cookies) } catch {}
    return legacy
  }

  const encFile = raw as EncryptedSessionFile
  const sessionSecret = retrieveSecret(accountId)
  if (!sessionSecret) return undefined
  try {
    const cookies = JSON.parse(decrypt(encFile.cookies_crypto, sessionSecret)) as any[]
    return {
      account_id: encFile.account_id,
      platform: encFile.platform,
      cookies,
      captured_at: encFile.captured_at,
    }
  } catch {
    return undefined
  }
}

export function sessionAgeHours(accountId: string): number | undefined {
  const fpath = sessionPath(accountId)
  if (!existsSync(fpath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(fpath, 'utf8')) as { captured_at?: string }
    if (!raw.captured_at) return undefined
    return (Date.now() - new Date(raw.captured_at).getTime()) / 1000 / 3600
  } catch {
    return undefined
  }
}
