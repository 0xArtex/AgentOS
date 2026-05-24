/**
 * Palmyr local config + data management
 * Everything lives in ~/.palmyr/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = join(homedir(), '.palmyr')

// One-time migration: rename legacy ~/.agentos/ → ~/.palmyr/ on first run after rebrand.
const LEGACY_HOME = join(homedir(), '.agentos')
if (existsSync(LEGACY_HOME) && !existsSync(HOME)) {
  try {
    renameSync(LEGACY_HOME, HOME)
    process.stderr.write(`migrated config dir: ${LEGACY_HOME} → ${HOME}\n`)
  } catch (e: any) {
    process.stderr.write(`warning: could not migrate ${LEGACY_HOME} → ${HOME}: ${e.message}\n`)
  }
}

// Directory structure
const DIRS = {
  root: HOME,
  data: join(HOME, 'data'),
  logs: join(HOME, 'logs'),
  drafts: join(HOME, 'drafts'),
  memory: join(HOME, 'memory'),
}

const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  // Prune log files older than 30 days
  try {
    const now = Date.now()
    for (const f of readdirSync(DIRS.logs).filter(f => f.endsWith('.log'))) {
      const fpath = join(DIRS.logs, f)
      if (now - statSync(fpath).mtimeMs > LOG_MAX_AGE_MS) {
        unlinkSync(fpath)
      }
    }
  } catch {}
}

// ── Config ──

export interface WalletConfig {
  keyfile?: string   // Legacy keyfile path
  vaultWalletId?: string  // Palmyr vault wallet ID (preferred)
}

export interface PalmyrConfig {
  api: string
  wallets: {
    solana?: WalletConfig
    base?: WalletConfig
  }
  /**
   * Legacy keyfile-flow chain. Only meaningful when at least one entry under
   * `wallets.*` has a `keyfile`. For vault-only users (`wallet create`), this
   * field is vestigial — `saveConfig` strips it so it doesn't clutter
   * `palmyr config` output. The x402 pay path reads `defaultPayChain`, not
   * this field.
   */
  defaultChain?: 'solana' | 'base'
  setupDone?: boolean
  vaultEnabled?: boolean
  apiKey?: string  // Palmyr API key for agent access
  defaultPayWalletId?: string  // Vault wallet ID used by x402 pay flow
  defaultPayChain?: 'solana' | 'base'  // Which chain to pay on for x402 (default: solana)
  // Legacy compat
  chain?: string
  keyfile?: string
}

const CONFIG_PATH = join(HOME, 'config.json')
const DEFAULT_CONFIG: PalmyrConfig = {
  api: 'https://palmyr.ai',
  wallets: {},
}

/**
 * True iff at least one wallet entry has a legacy keyfile path configured.
 * Used to decide whether `defaultChain` is still meaningful state.
 */
export function hasLegacyKeyfileWallet(config: PalmyrConfig): boolean {
  const w = config.wallets || {}
  return !!(w.solana?.keyfile || w.base?.keyfile)
}

export function loadConfig(): PalmyrConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    // Migrate legacy single-keyfile config
    if (raw.keyfile && !raw.wallets) {
      const chain = raw.chain || 'solana'
      raw.wallets = { [chain]: { keyfile: raw.keyfile } }
      raw.defaultChain = chain
      delete raw.keyfile
      delete raw.chain
    }
    return { ...DEFAULT_CONFIG, ...raw }
  } catch { return DEFAULT_CONFIG }
}

export function saveConfig(config: PalmyrConfig) {
  ensureDirs()
  // Self-healing: drop the vestigial legacy field on the next write so
  // vault-only configs stop showing a misleading `defaultChain` next to the
  // real `defaultPayChain`. Preserved when a keyfile wallet is actually
  // configured (the only place it's still meaningful, via `getKeyfile`).
  if (!hasLegacyKeyfileWallet(config) && 'defaultChain' in config) {
    delete config.defaultChain
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function addWalletToConfig(chain: 'solana' | 'base', keyfile: string) {
  const config = loadConfig()
  if (!config.wallets) config.wallets = {}
  config.wallets[chain] = { keyfile: keyfile.replace(homedir(), '~') }
  if (!config.setupDone) config.defaultChain = chain
  config.setupDone = true
  saveConfig(config)
}

// ── Credentials ──

export function getKeyfile(chain?: 'solana' | 'base'): string | null {
  const config = loadConfig()
  const targetChain = chain || config.defaultChain || 'solana'

  // Priority: env var > config wallet > default locations
  if (process.env.PALMYR_KEYFILE) return process.env.PALMYR_KEYFILE

  const walletConfig = config.wallets?.[targetChain]
  if (walletConfig?.keyfile) {
    const resolved = walletConfig.keyfile.replace('~', homedir())
    if (existsSync(resolved)) return resolved
  }

  // Default Solana location
  if (targetChain === 'solana') {
    const defaultSol = join(homedir(), '.config', 'solana', 'id.json')
    if (existsSync(defaultSol)) return defaultSol
  }

  return null
}

export function loadKeypair(chain?: 'solana' | 'base'): Uint8Array | null {
  const path = getKeyfile(chain)
  if (!path) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return Uint8Array.from(data)
  } catch { return null }
}

export function getConfiguredChains(): string[] {
  const config = loadConfig()
  return Object.keys(config.wallets || {})
}

// ── Data Store (small JSON files) ──

function dataPath(file: string) { return join(DIRS.data, file) }

export function getData(file: string): any {
  const p = dataPath(file)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

export function setData(file: string, data: any) {
  ensureDirs()
  writeFileSync(dataPath(file), JSON.stringify(data, null, 2))
}

// Helpers for common data
export function getPhones(): any[] { return getData('phones.json') || [] }
export function addPhone(phone: any) { const p = getPhones(); p.push(phone); setData('phones.json', p) }

export function getInboxes(): any[] { return getData('inboxes.json') || [] }
export function addInbox(inbox: any) { const i = getInboxes(); i.push(inbox); setData('inboxes.json', i) }

export function getServers(): any[] { return getData('servers.json') || [] }
export function addServer(server: any) { const s = getServers(); s.push(server); setData('servers.json', s) }

export function getDomains(): any[] { return getData('domains.json') || [] }
export function addDomain(domain: any) { const d = getDomains(); d.push(domain); setData('domains.json', d) }

export function getAccounts(): any[] { return getData('accounts.json') || [] }
export function addAccount(account: any) { const a = getAccounts(); a.push(account); setData('accounts.json', a) }

// ── Drafts ──

export function saveDraft(id: string, draft: any) {
  ensureDirs()
  writeFileSync(join(DIRS.drafts, `${id}.json`), JSON.stringify(draft, null, 2))
}

export function getDraft(id: string): any {
  const p = join(DIRS.drafts, `${id}.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

// ── Memory ──

export function addNote(note: string) {
  ensureDirs()
  const p = join(DIRS.memory, 'notes.md')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const timestamp = new Date().toISOString()
  writeFileSync(p, existing + `\n- [${timestamp}] ${note}`)
}

// ── Logging ──

export function log(message: string) {
  ensureDirs()
  const date = new Date().toISOString().split('T')[0]
  const p = join(DIRS.logs, `${date}.log`)
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const timestamp = new Date().toISOString()
  writeFileSync(p, existing + `[${timestamp}] ${message}\n`)
}
