/**
 * Palmyr wallet-trading subsystem (Phase 1: thesis-tracked Solana positions).
 *
 * Storage at `~/.palmyr/trading/` (overridable via PALMYR_TRADING_PATH):
 *   positions/<chain>/<mint>.json   — one open or closed position
 *   trades.jsonl                    — append-only audit log, never rewritten
 *   journal/YYYY-MM-DD.md           — daily freeform notes
 *   journal/index.jsonl             — structured journal index
 *   watchlist.jsonl                 — append-only watch entries
 *   config.json                     — defaults (rpc, slippage, default wallet)
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import {
  executeSwap,
  getSplTokenBalance,
  makeConnection,
  SOL_MINT,
} from '@palmyr/solana-trading'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { randomBytes } from 'crypto'

// ───────── Paths ─────────

export const TRADING_DIR =
  process.env.PALMYR_TRADING_PATH || join(homedir(), '.palmyr', 'trading')

export function ensureTradingDirs() {
  for (const d of [
    TRADING_DIR,
    join(TRADING_DIR, 'positions'),
    join(TRADING_DIR, 'positions', 'solana'),
    join(TRADING_DIR, 'journal'),
  ]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

export function positionPath(chain: 'solana', mint: string) {
  return join(TRADING_DIR, 'positions', chain, `${mint}.json`)
}
export function tradesLogPath() {
  return join(TRADING_DIR, 'trades.jsonl')
}
export function watchlistPath() {
  return join(TRADING_DIR, 'watchlist.jsonl')
}
export function configPath() {
  return join(TRADING_DIR, 'config.json')
}
export function journalIndexPath() {
  return join(TRADING_DIR, 'journal', 'index.jsonl')
}
export function journalDailyPath(isoDate: string) {
  return join(TRADING_DIR, 'journal', `${isoDate}.md`)
}

// ───────── Config ─────────

export interface TradingConfig {
  defaultChain?: 'solana'
  defaultWallet?: string
  defaultSlippageBps?: number
  rpcUrl?: string
  quoteMaxAgeMs?: number
}

const DEFAULT_CONFIG: TradingConfig = {
  defaultChain: 'solana',
  defaultSlippageBps: 100,
  quoteMaxAgeMs: 5000,
}

export function loadTradingConfig(): TradingConfig {
  const p = configPath()
  if (!existsSync(p)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveTradingConfig(cfg: TradingConfig) {
  ensureTradingDirs()
  atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2))
}

// ───────── Types ─────────

export interface PositionFile {
  chain: 'solana'
  mint: string
  wallet: string
  status: 'open' | 'closed'
  entry: {
    tx: string
    time: string
    amountIn: string
    amountInRawSol: number
    tokensOut: string
    tokensOutRaw: string
    tokenDecimals: number
    entryMcap: number | null
  }
  thesis: string
  exitPlan: {
    cut?: string
    takeProfit?: string
    holdIf?: string
  }
  riskFlags: string[]
  sells: Array<{
    tx: string
    time: string
    tokensIn: string
    tokensInRaw: string
    solOut: string
    solOutRaw: number
    percentRequested: number
    realizedSol: number
    reason: string
  }>
  pnl: {
    realizedSol: number
    unrealizedSol: number
    unrealizedPct: number
    lastPricedAt: string | null
  }
}

export type TradeLogLine =
  | {
      kind: 'buy'
      ts: string
      chain: 'solana'
      wallet: string
      mint: string
      tx: string
      solIn: number
      tokensOut: string
      tokenDecimals: number
      entryMcap: number | null
      slippageBps: number
      thesis: string
    }
  | {
      kind: 'sell'
      ts: string
      chain: 'solana'
      wallet: string
      mint: string
      tx: string
      tokensIn: string
      solOut: number
      percentRequested: number
      realizedSol: number
      reason: string
    }
  | {
      kind: 'sync'
      ts: string
      chain: 'solana'
      wallet: string
      mint: string
      drift: { onchain: string; book: string } | null
      note: string
    }

export interface JournalIndexLine {
  ts: string
  date: string
  ca: string | null
  note: string
}

export interface WatchEntry {
  ts: string
  ca: string
  trigger: string
}

// ───────── Atomic write ─────────

function atomicWriteFile(target: string, content: string) {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base = target.split(/[\\/]/).pop()
  const tmp = join(dir, `.${base}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, target)
}

// ───────── Position helpers ─────────

export function writePosition(p: PositionFile) {
  ensureTradingDirs()
  atomicWriteFile(positionPath(p.chain, p.mint), JSON.stringify(p, null, 2))
}

export function readPosition(chain: 'solana', mint: string): PositionFile | null {
  const p = positionPath(chain, mint)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PositionFile
  } catch {
    return null
  }
}

export interface PositionsFilter {
  chain?: 'solana'
  walletAddress?: string
  includeClosed?: boolean
}

export function listPositions(filter: PositionsFilter = {}): PositionFile[] {
  ensureTradingDirs()
  const chains: Array<'solana'> = filter.chain ? [filter.chain] : ['solana']
  const out: PositionFile[] = []
  for (const chain of chains) {
    const dir = join(TRADING_DIR, 'positions', chain)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PositionFile
        if (filter.walletAddress && p.wallet !== filter.walletAddress) continue
        if (!filter.includeClosed && p.status !== 'open') continue
        out.push(p)
      } catch {}
    }
  }
  return out
}

// ───────── Trade log ─────────

export function appendTradeLog(line: TradeLogLine) {
  ensureTradingDirs()
  appendFileSync(tradesLogPath(), JSON.stringify(line) + '\n')
}

// ───────── Journal ─────────

export function appendJournal(ca: string | null, note: string): { date: string; file: string } {
  ensureTradingDirs()
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const ts = now.toISOString()

  const dailyPath = journalDailyPath(date)
  const heading = `\n## ${ts} — ${ca ?? 'general'}\n`
  appendFileSync(dailyPath, heading + note + '\n')

  const idx: JournalIndexLine = {
    ts,
    date,
    ca,
    note: note.length > 120 ? note.slice(0, 117) + '...' : note,
  }
  appendFileSync(journalIndexPath(), JSON.stringify(idx) + '\n')

  return { date, file: dailyPath }
}

export function readJournalIndex(): JournalIndexLine[] {
  const p = journalIndexPath()
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JournalIndexLine
      } catch {
        return null
      }
    })
    .filter((x): x is JournalIndexLine => x !== null)
}

export function readJournalDay(isoDate: string): string {
  const p = journalDailyPath(isoDate)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

// ───────── Watch ─────────

export function appendWatch(entry: Omit<WatchEntry, 'ts'>): WatchEntry {
  ensureTradingDirs()
  const w: WatchEntry = { ts: new Date().toISOString(), ...entry }
  appendFileSync(watchlistPath(), JSON.stringify(w) + '\n')
  return w
}

export function listWatch(): WatchEntry[] {
  const p = watchlistPath()
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as WatchEntry
      } catch {
        return null
      }
    })
    .filter((x): x is WatchEntry => x !== null)
}

// ───────── Resolve signer ─────────

export interface ResolvedSigner {
  keypair: Keypair
  address: string
  source: 'vault' | 'env-secret-key' | 'env-keypair-path'
}

export async function resolveSigner(
  walletRef?: string,
  passphrase?: string,
): Promise<ResolvedSigner> {
  if (walletRef) {
    const { getVaultSolanaKeypair } = await import('./vault.js')
    const keypair = getVaultSolanaKeypair(walletRef, passphrase)
    return { keypair, address: keypair.publicKey.toBase58(), source: 'vault' }
  }
  const { loadKeypairFromEnv } = await import('@palmyr/solana-trading')
  const keypair = loadKeypairFromEnv()
  const fromSecret = !!process.env.WALLET_SECRET_KEY?.trim()
  return {
    keypair,
    address: keypair.publicKey.toBase58(),
    source: fromSecret ? 'env-secret-key' : 'env-keypair-path',
  }
}

// ───────── Helpers ─────────

/** Parses an --amount flag like "0.5sol" or "0.5 SOL" → lamports. */
export function parseAmountFlag(input: string): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(sol)$/i)
  if (!m) throw new Error(`Invalid --amount: "${input}". Expected e.g. "0.5sol".`)
  return Math.floor(Number(m[1]) * 1e9)
}

export function lamportsToSol(lamports: number): number {
  return lamports / 1e9
}

export function formatSolHuman(lamports: number, decimals = 4): string {
  return `${(lamports / 1e9).toFixed(decimals)} SOL`
}

export function formatTokensHuman(ui: number, maxDecimals = 6): string {
  return ui.toLocaleString('en-US', { maximumFractionDigits: maxDecimals })
}

/** Validates a base58 mint/pubkey. Throws on invalid input. */
export function assertValidMint(mint: string): PublicKey {
  try {
    return new PublicKey(mint)
  } catch {
    throw new Error(`Invalid mint address: ${mint}`)
  }
}

/**
 * Best-effort market cap at entry time: Jupiter /price × on-chain supply.
 * Returns null if either lookup fails — the position is still valid without it.
 */
async function fetchEntryMcapBestEffort(
  connection: Connection,
  mintB58: string,
): Promise<number | null> {
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mintB58}`)
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Record<string, { price: string } | null> }
    const priceStr = data.data?.[mintB58]?.price
    const priceUsd = priceStr ? Number(priceStr) : NaN
    if (!isFinite(priceUsd) || priceUsd <= 0) return null

    const mintInfo = await getMint(connection, new PublicKey(mintB58))
    const supplyUi = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals)
    if (!isFinite(supplyUi) || supplyUi <= 0) return null

    return priceUsd * supplyUi
  } catch {
    return null
  }
}

// ───────── buy ─────────

export interface BuyOpts {
  ca: string
  amount: string                    // e.g. "0.5sol"
  thesis: string
  cut?: string
  takeProfit?: string
  holdIf?: string
  riskFlags?: string[]
  walletRef?: string
  passphrase?: string
  slippageBps?: number
  dryRun?: boolean
  rpcUrl?: string
}

export interface BuyResult {
  positionPath: string
  txSignature: string
  amountIn: string
  amountInRawSol: number
  tokensOut: string
  tokensOutRaw: string
  tokenDecimals: number
  entryMcap: number | null
  wallet: string
  mint: string
  dryRun: boolean
}

export async function buy(opts: BuyOpts): Promise<BuyResult> {
  const mintPk = assertValidMint(opts.ca)
  if (!opts.thesis?.trim()) throw new Error('Missing --thesis')
  const amountInRawSol = parseAmountFlag(opts.amount)

  const existing = readPosition('solana', opts.ca)
  if (existing && existing.status === 'open') {
    throw new Error(
      `Position already open for ${opts.ca}. Use \`palmyr wallet sell\` to exit it first.`,
    )
  }

  const cfg = loadTradingConfig()
  const slippageBps = opts.slippageBps ?? cfg.defaultSlippageBps ?? 100
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl
  const quoteMaxAgeMs = cfg.quoteMaxAgeMs

  const signer = await resolveSigner(opts.walletRef, opts.passphrase)
  const connection: Connection = makeConnection(rpcUrl)

  const swap = await executeSwap({
    connection,
    wallet: signer.keypair,
    inputMint: SOL_MINT.toBase58(),
    outputMint: mintPk.toBase58(),
    inputAmountRaw: amountInRawSol,
    slippageBps,
    dryRun: opts.dryRun,
    quoteMaxAgeMs,
  })

  let tokenDecimals = 0
  try {
    const mintInfo = await getMint(connection, mintPk)
    tokenDecimals = mintInfo.decimals
  } catch {
    tokenDecimals = 0
  }
  const tokensOutRaw = String(swap.outputAmountRaw)
  const tokensOutUi = swap.outputAmountRaw / Math.pow(10, tokenDecimals)
  const tokensOut = formatTokensHuman(tokensOutUi, 6)

  const entryMcap = opts.dryRun
    ? null
    : await fetchEntryMcapBestEffort(connection, opts.ca)

  const nowIso = new Date().toISOString()
  const position: PositionFile = {
    chain: 'solana',
    mint: opts.ca,
    wallet: signer.address,
    status: 'open',
    entry: {
      tx: swap.txSignature,
      time: nowIso,
      amountIn: formatSolHuman(amountInRawSol, 4),
      amountInRawSol: amountInRawSol,
      tokensOut,
      tokensOutRaw,
      tokenDecimals,
      entryMcap,
    },
    thesis: opts.thesis.trim(),
    exitPlan: {
      cut: opts.cut,
      takeProfit: opts.takeProfit,
      holdIf: opts.holdIf,
    },
    riskFlags: opts.riskFlags ?? [],
    sells: [],
    pnl: {
      realizedSol: 0,
      unrealizedSol: 0,
      unrealizedPct: 0,
      lastPricedAt: null,
    },
  }

  writePosition(position)

  appendTradeLog({
    kind: 'buy',
    ts: nowIso,
    chain: 'solana',
    wallet: signer.address,
    mint: opts.ca,
    tx: swap.txSignature,
    solIn: amountInRawSol / 1e9,
    tokensOut,
    tokenDecimals,
    entryMcap,
    slippageBps,
    thesis: opts.thesis.trim(),
  })

  return {
    positionPath: positionPath('solana', opts.ca),
    txSignature: swap.txSignature,
    amountIn: position.entry.amountIn,
    amountInRawSol,
    tokensOut,
    tokensOutRaw,
    tokenDecimals,
    entryMcap,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
  }
}
