/**
 * AgentOS local config + data management
 * Everything lives in ~/.agentos/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = join(homedir(), '.agentos')

// Directory structure
const DIRS = {
  root: HOME,
  credentials: join(HOME, 'credentials'),
  data: join(HOME, 'data'),
  logs: join(HOME, 'logs'),
  drafts: join(HOME, 'drafts'),
  memory: join(HOME, 'memory'),
}

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

// ── Config ──

export interface WalletConfig {
  keyfile: string
}

export interface AgentOSConfig {
  api: string
  wallets: {
    solana?: WalletConfig
    base?: WalletConfig
  }
  defaultChain: 'solana' | 'base'
  setupDone?: boolean
  // Legacy compat
  chain?: string
  keyfile?: string
}

const CONFIG_PATH = join(HOME, 'config.json')
const DEFAULT_CONFIG: AgentOSConfig = {
  api: 'https://agntos.dev',
  wallets: {},
  defaultChain: 'solana',
}

export function loadConfig(): AgentOSConfig {
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

export function saveConfig(config: AgentOSConfig) {
  ensureDirs()
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
  if (process.env.AGENTOS_KEYFILE) return process.env.AGENTOS_KEYFILE

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

export function getWallets(): any[] { return getData('wallets.json') || [] }
export function addWallet(wallet: any) { const w = getWallets(); w.push(wallet); setData('wallets.json', w) }

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
