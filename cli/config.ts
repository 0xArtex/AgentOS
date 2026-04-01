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

export interface AgentOSConfig {
  api: string
  chain: 'solana' | 'base' | 'both'
  keyfile?: string
  setupDone?: boolean
}

const CONFIG_PATH = join(HOME, 'config.json')
const DEFAULT_CONFIG: AgentOSConfig = {
  api: 'https://agntos.dev',
  chain: 'solana',
}

export function loadConfig(): AgentOSConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }
  } catch { return DEFAULT_CONFIG }
}

export function saveConfig(config: AgentOSConfig) {
  ensureDirs()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ── Credentials ──

export function getKeyfile(): string | null {
  const config = loadConfig()
  // Priority: env var > config keyfile > default locations
  if (process.env.AGENTOS_KEYFILE) return process.env.AGENTOS_KEYFILE
  if (config.keyfile && existsSync(config.keyfile.replace('~', homedir()))) {
    return config.keyfile.replace('~', homedir())
  }
  // Default Solana location
  const defaultSol = join(homedir(), '.config', 'solana', 'id.json')
  if (existsSync(defaultSol)) return defaultSol
  return null
}

export function loadKeypair(): Uint8Array | null {
  const path = getKeyfile()
  if (!path) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return Uint8Array.from(data)
  } catch { return null }
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
