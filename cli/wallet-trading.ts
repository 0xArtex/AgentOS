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
  analyzeFill,
  executeSwap,
  fetchQuote,
  getSplTokenBalance,
  makeConnection,
  recommendSlippageBps,
  SOL_MINT,
  type FillForensics,
} from './solana/index.js'

// Sensible Jito tip default: 10,000 lamports = 0.00001 SOL (~$0.002 at $200/SOL).
// Enough to get prioritized on uncongested blocks. Bump via --tip for hot launches.
const DEFAULT_JITO_TIP_LAMPORTS = 10_000
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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
    join(TRADING_DIR, 'journal'),
  ]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  // Phase 4c — on every invocation, lazy-migrate any legacy chain-level
  // position files into per-wallet directories. Idempotent: after first run
  // the legacy directories are empty and the scan returns instantly.
  migrateLegacyPositions()
}

/**
 * Phase 4c — per-wallet position scoping.
 *
 * Solana base58 addresses are case-sensitive, EVM 0x-addresses are visually
 * mixed-case (checksummed) but case-insensitive at the protocol level. We
 * lowercase EVM addresses for the directory name so that Windows (which has a
 * case-insensitive filesystem by default) doesn't collide on the same wallet
 * with different display casings. Solana addresses are used verbatim — base58
 * collisions on the same wallet would be cosmic-ray rare.
 */
function walletDirName(walletAddr: string): string {
  if (walletAddr.startsWith('0x')) return walletAddr.toLowerCase()
  return walletAddr
}

function walletPositionsDir(walletAddr: string, chain: 'solana' | 'base'): string {
  return join(TRADING_DIR, 'positions', walletDirName(walletAddr), chain)
}

export function positionPath(chain: 'solana' | 'base', mint: string, walletAddr: string) {
  return join(walletPositionsDir(walletAddr, chain), `${mint}.json`)
}

/**
 * Path to the history directory holding archived closed positions for a
 * (wallet, chain). Re-entries on the same mint move the previous closed file
 * here so historical PnL and re-entry strategies aren't lost.
 */
function walletHistoryDir(walletAddr: string, chain: 'solana' | 'base'): string {
  return join(walletPositionsDir(walletAddr, chain), 'history')
}

/**
 * Build a unique archive filename for a closed position based on its entry
 * timestamp. Two positions on the same mint with distinct entries get distinct
 * filenames. Falls back to a random suffix if `entryTime` is malformed.
 */
function archivedPositionPath(p: PositionFile): string {
  const safeTs = p.entry.time?.replace(/[:.]/g, '-') ?? `unknown-${randomBytes(4).toString('hex')}`
  return join(walletHistoryDir(p.wallet, p.chain), `${p.mint}-${safeTs}.json`)
}

/**
 * Phase 4c — back-compat path generator for legacy reads + migration.
 * `positions/<chain>/<mint>.json` (no wallet dir). Used only during migration.
 */
function legacyPositionPath(chain: 'solana' | 'base', mint: string): string {
  return join(TRADING_DIR, 'positions', chain, `${mint}.json`)
}

/**
 * Walk legacy `positions/<chain>/*.json` files and move each to its
 * per-wallet location based on the `wallet` field embedded in the file. Runs
 * on every `ensureTradingDirs()` invocation but exits in O(1) once the legacy
 * dirs are empty. Idempotent: if a target path already exists (re-running
 * after a crashed migration), the legacy file is skipped.
 */
function migrateLegacyPositions() {
  for (const chain of ['solana', 'base'] as const) {
    const legacyDir = join(TRADING_DIR, 'positions', chain)
    if (!existsSync(legacyDir)) continue
    let entries: string[]
    try {
      entries = readdirSync(legacyDir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      const legacyPath = join(legacyDir, f)
      try {
        const stat = statSync(legacyPath)
        if (!stat.isFile()) continue
        const raw = readFileSync(legacyPath, 'utf8')
        const p = JSON.parse(raw) as PositionFile
        if (!p.wallet || !p.chain || !p.mint) continue
        if (p.chain !== chain) continue
        const newDir = walletPositionsDir(p.wallet, chain)
        if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true })
        const newPath = join(newDir, f)
        if (existsSync(newPath)) continue // already migrated
        renameSync(legacyPath, newPath)
      } catch {
        // Best-effort migration — if a single file fails (corrupt JSON, etc.),
        // leave it and move on.
      }
    }
  }
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

/**
 * Asset identifier for canonical accounting. SOL + USDC are Solana-native;
 * ETH + USDC are Base-native. USDC appears in both because the same fungible
 * stablecoin trades on both chains.
 */
export type TradingAsset = 'SOL' | 'ETH' | 'USDC'

/**
 * Asset-tagged amount, used for canonical sell-output and PnL accounting.
 * `raw` is u256-safe string (lamports/wei/USDC-6dec). `display` is a
 * human-readable form like "0.500000 USDC" or "0.005000 ETH".
 */
export interface AssetAmount {
  asset: TradingAsset
  raw: string
  display: string
}

/**
 * Asset-tagged PnL value as a JS Number in asset units. ETH and SOL are
 * fractional, USDC is dollars. The unit is `asset` — never mix.
 */
export interface AssetPnl {
  asset: TradingAsset
  amount: number
}

/** Phase 5b — exit plan is identical across chains (just string thresholds). */
export interface ExitPlan {
  cut?: string
  takeProfit?: string
  holdIf?: string
  trailingStop?: string
  timeLimit?: string
  thesisCheck?: string
}

/** Phase 5b — monitor state is identical across chains. */
export interface MonitorState {
  peakUnrealizedPct: number
  peakAt: string
  lastThesisCheckAt?: string
  lastThesisVerdict?: 'yes' | 'no' | 'unclear'
  lastThesisReasoning?: string
  lastThesisFiredAt?: string
  /** Per-trigger fire watermark (ISO ts) so non-auto monitoring stays idempotent across ticks. */
  firedTriggers?: Partial<Record<'cut' | 'takeProfit' | 'trailingStop' | 'timeLimit', string>>
}

export interface SolanaEntry {
  tx: string
  time: string
  amountIn: string                    // e.g. "0.5 SOL" or "10.00 USDC"
  /** Native lamports for legacy SOL positions. Kept for back-compat — new code reads `amountInRaw` + `inputAsset`. */
  amountInRawSol: number
  tokensOut: string
  tokensOutRaw: string                // raw u64 as decimal string
  tokenDecimals: number
  entryMcap: number | null
  feeLamports?: number
  tipLamports?: number
  slippageBpsUsed?: number
  protectedExec?: boolean
  /** Phase 4c — links this entry to a cohort buy (same string across all the wallets involved). */
  cohortId?: string
  // ── USDC-input support ─────────────────────────────────────────────────
  /** The asset the user spent to open this position. Missing on legacy files; treated as 'SOL'. */
  inputAsset?: SolanaInputAsset
  /** Raw amount of `inputAsset` spent. Lamports for SOL (9 dec), 6-dec raw for USDC. */
  amountInRaw?: number
}

export interface SolanaSell {
  tx: string
  time: string
  tokensIn: string
  tokensInRaw: string
  percentRequested: number
  reason: string
  feeLamports?: number
  tipLamports?: number
  slippageBpsUsed?: number
  protectedExec?: boolean
  forensics?: FillForensics
  /** Asset this sell exited to (mirrors entry.inputAsset). */
  outputAsset: SolanaInputAsset
  /** Realized output (asset-tagged). Holds USDC values on USDC exits — name no longer chain-typed. */
  output: AssetAmount
  /** Realized PnL for this sell (asset-tagged). */
  realized: AssetPnl
  /**
   * @deprecated Read `output.display` / `output.raw` / `realized.amount` instead.
   * Optional only so legacy position files on disk (pre-canonical) still parse;
   * new sells no longer set these.
   */
  solOut?: string
  /** @deprecated Use `output.raw`. */
  solOutRaw?: number
  /** @deprecated Use `realized.amount`. */
  realizedSol?: number
}

export interface SolanaPnl {
  unrealizedPct: number
  lastPricedAt: string | null
  /** Realized PnL across all sells (asset-tagged). */
  realized: AssetPnl
  /** Mark-to-market unrealized PnL (asset-tagged). */
  unrealized: AssetPnl
  /** @deprecated Use `realized.amount`. */
  realizedSol?: number
  /** @deprecated Use `unrealized.amount`. */
  unrealizedSol?: number
}

export interface SolanaPositionFile {
  chain: 'solana'
  mint: string
  wallet: string
  status: 'open' | 'closed'
  entry: SolanaEntry
  thesis: string
  exitPlan: ExitPlan
  monitorState?: MonitorState
  riskFlags: string[]
  sells: SolanaSell[]
  pnl: SolanaPnl
}

/** Phase 5b — Base/EVM position file. Raw amounts are u256 strings for safety. */
export interface BaseEntry {
  tx: string                          // 0x... tx hash
  time: string
  amountIn: string                    // e.g. "0.01 ETH" or "10.00 USDC"
  /** Raw wei for legacy ETH positions. Kept for back-compat — new code reads `amountInRaw` + `inputAsset`. */
  amountInRawWei: string
  tokensOut: string
  tokensOutRaw: string                // u256 raw token units
  tokenDecimals: number
  entryMcap: number | null
  feeWei?: string                     // u256 gas fee paid
  /** Phase 5b lite: protected execution on Base (Flashbots) is deferred to 5c. */
  slippageBpsUsed?: number
  protectedExec?: boolean
  /** Phase 4c — links this entry to a cohort buy (same string across all the wallets involved). */
  cohortId?: string
  // ── USDC-input support ─────────────────────────────────────────────────
  /** Asset spent to open this position. Missing on legacy files; treated as 'ETH'. */
  inputAsset?: BaseInputAsset
  /** Raw amount of `inputAsset`. Wei for ETH (18 dec), 6-dec raw for USDC. String for u256 safety. */
  amountInRaw?: string
}

export interface BaseSell {
  tx: string
  time: string
  tokensIn: string
  tokensInRaw: string                 // u256 raw token units
  percentRequested: number
  reason: string
  feeWei?: string
  slippageBpsUsed?: number
  protectedExec?: boolean
  forensics?: FillForensics
  /** Asset this sell exited to (mirrors entry.inputAsset). */
  outputAsset: BaseInputAsset
  /** Realized output (asset-tagged). Holds USDC values on USDC exits — name no longer chain-typed. */
  output: AssetAmount
  /** Realized PnL for this sell (asset-tagged). */
  realized: AssetPnl
  /**
   * @deprecated Read `output.display` / `output.raw` / `realized.amount` instead.
   * Optional only so legacy position files on disk (pre-canonical) still parse;
   * new sells no longer set these.
   */
  ethOut?: string
  /** @deprecated Use `output.raw`. */
  ethOutRawWei?: string
  /** @deprecated Use `realized.amount`. */
  realizedEth?: number
}

export interface BasePnl {
  unrealizedPct: number
  lastPricedAt: string | null
  /** Realized PnL across all sells (asset-tagged). */
  realized: AssetPnl
  /** Mark-to-market unrealized PnL (asset-tagged). */
  unrealized: AssetPnl
  /** @deprecated Use `realized.amount`. */
  realizedEth?: number
  /** @deprecated Use `unrealized.amount`. */
  unrealizedEth?: number
}

export interface BasePositionFile {
  chain: 'base'
  mint: string                        // 0x... token contract address
  wallet: string                      // 0x... EOA address
  status: 'open' | 'closed'
  entry: BaseEntry
  thesis: string
  exitPlan: ExitPlan
  monitorState?: MonitorState
  riskFlags: string[]
  sells: BaseSell[]
  pnl: BasePnl
}

export type PositionFile = SolanaPositionFile | BasePositionFile

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
      // Phase 2 additions
      protectedExec?: boolean
      feeLamports?: number
      tipLamports?: number
      forensics?: FillForensics
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
      // Phase 2 additions
      protectedExec?: boolean
      feeLamports?: number
      tipLamports?: number
      forensics?: FillForensics
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
  | {
      kind: 'monitor_fire'
      ts: string
      chain: 'solana' | 'base'        // Phase 5d
      wallet: string
      mint: string
      trigger: 'cut' | 'takeProfit' | 'trailingStop' | 'timeLimit' | 'thesis_falsified'
      currentPct: number
      thresholdPct?: number           // cut/takeProfit/trailingStop
      peakPct?: number                // trailingStop
      drawdownPct?: number            // trailingStop: peakPct − currentPct
      thresholdDurationMs?: number    // timeLimit
      elapsedMs?: number              // timeLimit
      llmVerdict?: 'yes' | 'no' | 'unclear'  // thesis_falsified
      llmReasoning?: string           // thesis_falsified
      proposedAction: 'sell-100'
      autoExecuted: boolean
      linkedSellTx?: string
      note?: string
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

/**
 * Back-compat normalization. Pre-USDC positions don't have `inputAsset` or
 * `amountInRaw`. We derive them from the legacy fields (`amountInRawSol` on
 * Solana, `amountInRawWei` on Base) so downstream code can rely on the new
 * canonical fields without per-callsite branching.
 *
 * Pure function — mutates the passed object in place AND returns it. Idempotent.
 */
export function normalizePosition(p: PositionFile): PositionFile {
  if (p.chain === 'solana') {
    if (!p.entry.inputAsset) p.entry.inputAsset = 'SOL'
    if (p.entry.amountInRaw === undefined) {
      p.entry.amountInRaw = p.entry.inputAsset === 'SOL'
        ? p.entry.amountInRawSol
        : 0
    }
    for (const s of p.sells) {
      if (!s.outputAsset) s.outputAsset = p.entry.inputAsset ?? 'SOL'
      // Back-fill canonical fields from legacy `solOut*` / `realizedSol` if the
      // file pre-dates the canonical schema, then strip the legacy fields so
      // they don't get re-emitted on the next write.
      if (!s.output && s.solOutRaw !== undefined && s.solOut !== undefined) {
        s.output = {
          asset: s.outputAsset,
          raw: String(s.solOutRaw),
          display: s.solOut,
        }
      }
      if (!s.realized && s.realizedSol !== undefined) {
        s.realized = { asset: s.outputAsset, amount: s.realizedSol }
      }
      delete s.solOut
      delete s.solOutRaw
      delete s.realizedSol
    }
    if (!p.pnl.realized && p.pnl.realizedSol !== undefined) {
      p.pnl.realized = { asset: p.entry.inputAsset, amount: p.pnl.realizedSol }
    }
    if (!p.pnl.unrealized && p.pnl.unrealizedSol !== undefined) {
      p.pnl.unrealized = { asset: p.entry.inputAsset, amount: p.pnl.unrealizedSol }
    }
    // Guarantee canonical pnl shape exists for downstream readers.
    if (!p.pnl.realized) p.pnl.realized = { asset: p.entry.inputAsset, amount: 0 }
    if (!p.pnl.unrealized) p.pnl.unrealized = { asset: p.entry.inputAsset, amount: 0 }
    delete p.pnl.realizedSol
    delete p.pnl.unrealizedSol
  } else {
    if (!p.entry.inputAsset) p.entry.inputAsset = 'ETH'
    if (p.entry.amountInRaw === undefined) {
      p.entry.amountInRaw = p.entry.inputAsset === 'ETH'
        ? p.entry.amountInRawWei
        : '0'
    }
    for (const s of p.sells) {
      if (!s.outputAsset) s.outputAsset = p.entry.inputAsset ?? 'ETH'
      if (!s.output && s.ethOutRawWei !== undefined && s.ethOut !== undefined) {
        s.output = {
          asset: s.outputAsset,
          raw: s.ethOutRawWei,
          display: s.ethOut,
        }
      }
      if (!s.realized && s.realizedEth !== undefined) {
        s.realized = { asset: s.outputAsset, amount: s.realizedEth }
      }
      delete s.ethOut
      delete s.ethOutRawWei
      delete s.realizedEth
    }
    if (!p.pnl.realized && p.pnl.realizedEth !== undefined) {
      p.pnl.realized = { asset: p.entry.inputAsset, amount: p.pnl.realizedEth }
    }
    if (!p.pnl.unrealized && p.pnl.unrealizedEth !== undefined) {
      p.pnl.unrealized = { asset: p.entry.inputAsset, amount: p.pnl.unrealizedEth }
    }
    if (!p.pnl.realized) p.pnl.realized = { asset: p.entry.inputAsset, amount: 0 }
    if (!p.pnl.unrealized) p.pnl.unrealized = { asset: p.entry.inputAsset, amount: 0 }
    delete p.pnl.realizedEth
    delete p.pnl.unrealizedEth
  }
  return p
}

export function writePosition(p: PositionFile) {
  ensureTradingDirs()
  // Always run normalization before writing so files on disk have canonical
  // shape, but keep legacy `amountInRawSol` / `amountInRawWei` populated when
  // the position is native (so external readers / pre-USDC tooling still work).
  normalizePosition(p)
  atomicWriteFile(positionPath(p.chain, p.mint, p.wallet), JSON.stringify(p, null, 2))
}

/**
 * Archive a closed position to the per-wallet/per-chain history directory.
 * Called when a re-entry on the same `(wallet, chain, mint)` is about to write
 * a fresh position file. Without this, the second buy would overwrite the
 * first closed cycle and historical PnL would lose the trade.
 *
 * No-op if the position is still open, or if the archive already exists (so
 * a crashed write doesn't lose data on retry — the live file is left in place
 * for the caller to handle).
 */
function archiveClosedPosition(p: PositionFile): { archived: boolean; path: string | null } {
  if (p.status !== 'closed') return { archived: false, path: null }
  const livePath = positionPath(p.chain, p.mint, p.wallet)
  const archivePath = archivedPositionPath(p)
  if (existsSync(archivePath)) return { archived: false, path: archivePath }
  const archiveDir = dirname(archivePath)
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  try {
    renameSync(livePath, archivePath)
    return { archived: true, path: archivePath }
  } catch {
    return { archived: false, path: null }
  }
}

/**
 * List historical (archived) closed positions for the given filter. Returns
 * empty when no archive directory exists. Used by PnL / journal reconciliation
 * to count re-entries that would otherwise be invisible in `listPositions`.
 */
export function listHistoricalPositions(filter: PositionsFilter = {}): PositionFile[] {
  ensureTradingDirs()
  const chains: Array<'solana' | 'base'> = filter.chain
    ? [filter.chain]
    : ['solana', 'base']
  const positionsRoot = join(TRADING_DIR, 'positions')
  if (!existsSync(positionsRoot)) return []
  const wantWallets = walletFilterSet(filter)

  let walletDirs: string[]
  try {
    walletDirs = readdirSync(positionsRoot)
  } catch {
    return []
  }

  const out: PositionFile[] = []
  for (const walletEntry of walletDirs) {
    if (walletEntry === 'solana' || walletEntry === 'base') continue
    const walletPath = join(positionsRoot, walletEntry)
    try {
      if (!statSync(walletPath).isDirectory()) continue
    } catch {
      continue
    }
    if (wantWallets !== null && !wantWallets.has(walletEntry)) continue
    for (const chain of chains) {
      const historyDir = join(walletPath, chain, 'history')
      if (!existsSync(historyDir)) continue
      let entries: string[]
      try {
        entries = readdirSync(historyDir)
      } catch {
        continue
      }
      for (const f of entries) {
        if (!f.endsWith('.json')) continue
        try {
          const p = normalizePosition(JSON.parse(readFileSync(join(historyDir, f), 'utf8')) as PositionFile)
          out.push(p)
        } catch {}
      }
    }
  }
  return out
}

/**
 * Phase 4c — `readPosition` has two modes:
 *   - With `walletAddr`: O(1) direct file lookup, scoped to that wallet.
 *   - Without `walletAddr`: scans every wallet dir for the first matching
 *     (chain, mint). Used by `wallet position <CA>` and `wallet brief <CA>`
 *     where the caller doesn't know which wallet to ask about. If multiple
 *     wallets hold the same token, the first one found wins — callers that
 *     need precision should pass the wallet explicitly.
 */
export function readPosition(chain: 'solana', mint: string, walletAddr?: string): SolanaPositionFile | null
export function readPosition(chain: 'base', mint: string, walletAddr?: string): BasePositionFile | null
export function readPosition(chain: 'solana' | 'base', mint: string, walletAddr?: string): PositionFile | null
export function readPosition(chain: 'solana' | 'base', mint: string, walletAddr?: string): PositionFile | null {
  if (walletAddr) {
    const p = positionPath(chain, mint, walletAddr)
    if (!existsSync(p)) return null
    try {
      return normalizePosition(JSON.parse(readFileSync(p, 'utf8')) as PositionFile)
    } catch {
      return null
    }
  }
  // Fallback: scan all wallets for this (chain, mint).
  for (const p of listPositions({ chain, includeClosed: true })) {
    if (p.mint === mint) return p
  }
  return null
}

export interface PositionsFilter {
  chain?: 'solana' | 'base'
  /**
   * Either a single address, or a list of addresses — useful for the cross-chain
   * case where a named vault wallet maps to both a Solana base58 address and an
   * EVM 0x address. Matched as a set: a position passes if its `wallet` matches
   * any entry.
   */
  walletAddress?: string | string[]
  includeClosed?: boolean
}

/** Normalize a single-or-array address filter to a Set of normalized dir names. */
function walletFilterSet(filter: PositionsFilter): Set<string> | null {
  if (!filter.walletAddress) return null
  const list = Array.isArray(filter.walletAddress) ? filter.walletAddress : [filter.walletAddress]
  if (list.length === 0) return null
  return new Set(list.map(walletDirName))
}

export function listPositions(filter: { chain: 'solana'; walletAddress?: string | string[]; includeClosed?: boolean }): SolanaPositionFile[]
export function listPositions(filter: { chain: 'base'; walletAddress?: string | string[]; includeClosed?: boolean }): BasePositionFile[]
export function listPositions(filter?: PositionsFilter): PositionFile[]
export function listPositions(filter: PositionsFilter = {}): PositionFile[] {
  ensureTradingDirs()
  const chains: Array<'solana' | 'base'> = filter.chain
    ? [filter.chain]
    : ['solana', 'base']
  const positionsRoot = join(TRADING_DIR, 'positions')
  if (!existsSync(positionsRoot)) return []

  const out: PositionFile[] = []
  // Phase 4c — walk `positions/<wallet>/<chain>/<mint>.json`. Skip legacy
  // chain-level dirs (`positions/solana`, `positions/base`) — those are
  // handled by `migrateLegacyPositions()` on `ensureTradingDirs()`.
  const wantWallets = walletFilterSet(filter)

  let walletDirs: string[]
  try {
    walletDirs = readdirSync(positionsRoot)
  } catch {
    return []
  }

  for (const walletEntry of walletDirs) {
    if (walletEntry === 'solana' || walletEntry === 'base') continue
    const walletPath = join(positionsRoot, walletEntry)
    try {
      if (!statSync(walletPath).isDirectory()) continue
    } catch {
      continue
    }
    if (wantWallets !== null && !wantWallets.has(walletEntry)) continue
    for (const chain of chains) {
      const chainDir = join(walletPath, chain)
      if (!existsSync(chainDir)) continue
      let chainEntries: string[]
      try {
        chainEntries = readdirSync(chainDir)
      } catch {
        continue
      }
      for (const f of chainEntries) {
        if (!f.endsWith('.json')) continue
        try {
          const p = normalizePosition(JSON.parse(readFileSync(join(chainDir, f), 'utf8')) as PositionFile)
          if (!filter.includeClosed && p.status !== 'open') continue
          out.push(p)
        } catch {}
      }
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

// ───────── Cross-chain wallet resolution ─────────

/**
 * Resolved set of on-chain addresses a single wallet ref covers. Vault wallets
 * derive both Solana and EVM addresses from the same mnemonic; trading-keystore
 * refs (`trading:N`) likewise derive both. Either side can be null if the ref
 * can't be coerced into that chain's signer (e.g. raw-key wallets).
 *
 * Used by `wallet positions`, `wallet brief`, `wallet sync`, and the daemon to
 * filter positions across BOTH chains for a named wallet — without this, a
 * Base position on the same wallet was invisible when filtering by name.
 */
export interface WalletAddresses {
  ref: string
  solanaAddress: string | null
  evmAddress: string | null
}

/**
 * Resolve a wallet ref (vault name/id or `trading:N`) to its Solana + EVM
 * addresses. Best-effort on both sides — a failure on one chain doesn't
 * abort the other. Used to flatten cross-chain filtering.
 */
export async function resolveWalletAddresses(
  walletRef: string,
  passphrase?: string,
): Promise<WalletAddresses> {
  let solanaAddress: string | null = null
  let evmAddress: string | null = null
  try {
    const sol = await resolveSigner(walletRef, passphrase)
    solanaAddress = sol.address
  } catch {
    // raw-key wallets and other Solana-incompatible refs are non-fatal
  }
  try {
    const evm = await resolveEvmSigner(walletRef, passphrase)
    evmAddress = evm.address
  } catch {
    // raw-key wallets and other EVM-incompatible refs are non-fatal
  }
  return { ref: walletRef, solanaAddress, evmAddress }
}

// ───────── Resolve signer ─────────

export interface ResolvedSigner {
  keypair: Keypair
  address: string
  source: 'vault' | 'env-secret-key' | 'env-keypair-path' | 'trading-keystore'
  /** Set when source === 'trading-keystore'. */
  keystoreIndex?: number
}

export async function resolveSigner(
  walletRef?: string,
  passphrase?: string,
): Promise<ResolvedSigner> {
  // Phase 4: `trading:N` refers to the Nth wallet derived from the encrypted
  // trading keystore. Auth fallback chain inside getKeystoreKeypair:
  //   1. explicit passphrase arg (if provided)
  //   2. PALMYR_TRADING_KEYSTORE_PASSPHRASE env var
  //   3. cached seed in OS keychain (after `trading-keystore unlock`)
  // Routed before the vault path so a future vault wallet named `trading:0`
  // couldn't shadow it.
  if (walletRef?.startsWith('trading:')) {
    const indexStr = walletRef.slice('trading:'.length)
    const index = Number(indexStr)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid trading wallet index: "${indexStr}". Use trading:0, trading:1, ...`)
    }
    const pass = passphrase ?? process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE
    const { getKeystoreKeypair } = await import('./wallet-trading-keystore.js')
    const keypair = getKeystoreKeypair(index, pass)
    return {
      keypair,
      address: keypair.publicKey.toBase58(),
      source: 'trading-keystore',
      keystoreIndex: index,
    }
  }

  if (walletRef) {
    const { getVaultSolanaKeypair } = await import('./vault.js')
    const keypair = getVaultSolanaKeypair(walletRef, passphrase)
    return { keypair, address: keypair.publicKey.toBase58(), source: 'vault' }
  }

  const { loadKeypairFromEnv } = await import('./solana/index.js')
  const keypair = loadKeypairFromEnv()
  const fromSecret = !!process.env.WALLET_SECRET_KEY?.trim()
  return {
    keypair,
    address: keypair.publicKey.toBase58(),
    source: fromSecret ? 'env-secret-key' : 'env-keypair-path',
  }
}

// ───────── Helpers ─────────

/** USDC mint on Solana mainnet — 6 decimals. */
export const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** Asset types funded trades can spend / receive. */
export type SolanaInputAsset = 'SOL' | 'USDC'
export type BaseInputAsset = 'ETH' | 'USDC'

export interface SolanaParsedAmount {
  asset: SolanaInputAsset
  raw: number               // lamports for SOL, 6-dec raw for USDC (both fit JS Number for typical sizes)
  display: string           // e.g. "0.5000 SOL" or "10.00 USDC"
}

export interface BaseParsedAmount {
  asset: BaseInputAsset
  raw: string               // wei for ETH (u256-safe BigInt string), 6-dec raw for USDC (fits but kept string for uniformity)
  display: string
}

/** Parses an --amount flag for Solana: "0.5sol" / "10usdc". Suffix is required. */
export function parseAmountFlag(input: string): number {
  // Back-compat: legacy callers want lamports back directly. Keep the simple SOL parser available.
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*sol$/i)
  if (!m) throw new Error(`Invalid --amount: "${input}". Expected e.g. "0.5sol".`)
  return Math.floor(Number(m[1]) * 1e9)
}

/**
 * Parse a Solana --amount with asset discrimination. Suffix is required and
 * determines the input asset — `Nsol` for native SOL, `Nusdc` for USDC.
 *
 * Decimals: SOL = 9 (lamports), USDC = 6.
 */
export function parseSolanaInputAmount(input: string): SolanaParsedAmount {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(sol|usdc)$/i)
  if (!m) throw new Error(`Invalid --amount: "${input}". Expected e.g. "0.5sol" or "10usdc".`)
  const value = Number(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'sol') {
    return {
      asset: 'SOL',
      raw: Math.floor(value * 1e9),
      display: `${value.toFixed(4)} SOL`,
    }
  }
  return {
    asset: 'USDC',
    raw: Math.floor(value * 1e6),
    display: `${value.toFixed(2)} USDC`,
  }
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

/** Phase 5b — validates a 0x-prefixed EVM address. Returns the original string. */
export function assertValidEvmAddress(addr: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error(`Invalid EVM address: ${addr}`)
  }
  return addr
}

/**
 * Phase 5b — parse `--amount` for Base: accepts `Neth`, `Ngwei`, `Nwei`.
 * Returns a u256-safe wei string. Unrecognized formats throw.
 */
export function parseEvmAmount(input: string): string {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(eth|gwei|wei)?$/i)
  if (!m) throw new Error(`Invalid --amount: "${input}". Expected e.g. "0.01eth" or "10000000000000000wei".`)
  const n = m[1]
  const unit = (m[2] || 'eth').toLowerCase()
  if (unit === 'wei') {
    // bare integer string already represents wei
    return n.includes('.') ? BigInt(Math.floor(Number(n))).toString() : n
  }
  if (unit === 'gwei') {
    // gwei = 1e9 wei
    return (BigInt(Math.floor(Number(n) * 1e9))).toString()
  }
  // eth = 1e18 wei
  const [intPart, fracPart = ''] = n.split('.')
  const padded = (fracPart + '0'.repeat(18)).slice(0, 18)
  return (BigInt(intPart) * 10n ** 18n + BigInt(padded || '0')).toString()
}

/**
 * Parse a Base --amount with asset discrimination. Suffix governs the input
 * asset and how the value is converted to raw units:
 *   - `Neth` / `Ngwei` / `Nwei` → ETH (18 decimals); default if suffix omitted
 *   - `Nusdc` → USDC (6 decimals)
 */
export function parseBaseInputAmount(input: string): BaseParsedAmount {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(eth|gwei|wei|usdc)?$/i)
  if (!m) throw new Error(`Invalid --amount: "${input}". Expected e.g. "0.01eth", "1000gwei", "1000wei", or "10usdc".`)
  const n = m[1]
  const unit = (m[2] || 'eth').toLowerCase()
  if (unit === 'usdc') {
    const [intPart, fracPart = ''] = n.split('.')
    const padded = (fracPart + '000000').slice(0, 6)
    const raw = (BigInt(intPart) * 1_000_000n + BigInt(padded || '0')).toString()
    return { asset: 'USDC', raw, display: `${Number(n).toFixed(2)} USDC` }
  }
  if (unit === 'wei') {
    const raw = n.includes('.') ? BigInt(Math.floor(Number(n))).toString() : n
    return { asset: 'ETH', raw, display: `${raw} wei` }
  }
  if (unit === 'gwei') {
    const raw = BigInt(Math.floor(Number(n) * 1e9)).toString()
    return { asset: 'ETH', raw, display: `${n} gwei` }
  }
  // eth (default when no suffix)
  const [intPart, fracPart = ''] = n.split('.')
  const padded = (fracPart + '0'.repeat(18)).slice(0, 18)
  const raw = (BigInt(intPart) * 10n ** 18n + BigInt(padded || '0')).toString()
  return { asset: 'ETH', raw, display: `${Number(n).toFixed(6)} ETH` }
}

export function formatEthHuman(weiStr: string, decimals = 6): string {
  const wei = BigInt(weiStr)
  const whole = wei / 10n ** 18n
  const frac = wei % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals)
  return `${whole}.${fracStr} ETH`
}

/** Format a USDC raw amount (6 decimals) for human display. Works for any chain. */
export function formatUsdcHuman(raw: string | number, decimals = 2): string {
  const rawNum = typeof raw === 'string' ? Number(raw) : raw
  return `${(rawNum / 1e6).toFixed(decimals)} USDC`
}

// ───────── EVM signer resolver ─────────

export interface ResolvedEvmSigner {
  /** ethers.Wallet without a provider attached. Caller does `.connect(provider)`. */
  wallet: import('ethers').Wallet
  address: string
  source: 'trading-keystore' | 'vault'
  /** Set when source === 'trading-keystore'. */
  keystoreIndex?: number
}

/**
 * Resolve `--wallet <ref>` to an EVM wallet. Two paths:
 *   1. `trading:N` — HD-derived from the dedicated trading keystore (power user,
 *      one mnemonic → many wallets at consecutive indices).
 *   2. Any other ref → looked up in the regular Palmyr vault. Vault wallets
 *      are BIP39 + Solana + EVM out of the box (`vault.ts:getVaultEvmWallet`),
 *      and use the same OS-keychain session-secret cache as everywhere else
 *      in the CLI — so unattended daemon use works without a separate cache.
 *
 * Vault is the default UX: `palmyr wallet create` → use that wallet for both
 * Solana and Base trading. Trading-keystore stays available for cohort-heavy
 * power users who want N HD-derived wallets from a single seed.
 */
export async function resolveEvmSigner(
  walletRef?: string,
  passphrase?: string,
): Promise<ResolvedEvmSigner> {
  if (!walletRef) {
    throw new Error('For Base, --wallet is required (vault wallet name/id, or `trading:N`).')
  }
  if (walletRef.startsWith('trading:')) {
    const indexStr = walletRef.slice('trading:'.length)
    const index = Number(indexStr)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid trading wallet index: "${indexStr}". Use trading:0, trading:1, ...`)
    }
    const pass = passphrase ?? process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE
    const { getKeystoreEvmWallet } = await import('./wallet-trading-keystore.js')
    const wallet = getKeystoreEvmWallet(index, pass)
    return {
      wallet,
      address: wallet.address,
      source: 'trading-keystore',
      keystoreIndex: index,
    }
  }

  // Default path: regular vault wallet by id or name.
  const { getVaultEvmWallet } = await import('./vault.js')
  let wallet: import('ethers').Wallet
  try {
    wallet = getVaultEvmWallet(walletRef, passphrase) as import('ethers').Wallet
  } catch (e: any) {
    throw new Error(
      `Could not resolve --wallet '${walletRef}' from the vault: ${e?.message ?? String(e)}. ` +
      `Create one with \`palmyr wallet create\` or use a keystore ref like \`trading:0\`.`,
    )
  }
  return {
    wallet,
    address: wallet.address,
    source: 'vault',
  }
}

// ───────── buyBase ─────────

export interface BuyBaseOpts {
  ca: string                                // 0x... ERC20 contract address
  amount: string                            // e.g. "0.01eth", "1000gwei", "10000000000000000wei"
  thesis: string
  cut?: string
  takeProfit?: string
  holdIf?: string
  trailingStop?: string
  timeLimit?: string
  thesisCheck?: string
  riskFlags?: string[]
  walletRef?: string                        // `trading:N` only for Phase 5b
  passphrase?: string
  slippageBps?: number
  dryRun?: boolean
  rpcUrl?: string
  // Phase 5d — MEV-protected execution.
  protectedExec?: boolean
  /** EIP-1559 maxPriorityFeePerGas tip in wei. Only used when protectedExec. */
  priorityFeeWei?: bigint
  // Phase 4c — cohort buy tag (set by cohortBuy() for each per-wallet leg)
  cohortId?: string
}

export interface BuyBaseResult {
  positionPath: string
  txHash: string
  amountIn: string
  amountInRawWei: string
  tokensOut: string
  tokensOutRaw: string
  tokenDecimals: number
  wallet: string
  mint: string
  dryRun: boolean
  feeWei: string
  slippageBpsUsed: number
  protectedExec: boolean
  rpcUrl: string
  inputAsset: BaseInputAsset
  /** One-line human-readable summary; safe to print directly. */
  summary: string
}

export async function buyBase(opts: BuyBaseOpts): Promise<BuyBaseResult> {
  assertValidEvmAddress(opts.ca)
  if (!opts.thesis?.trim()) throw new Error('Missing --thesis')

  // USDC-aware amount parsing.
  const parsed = parseBaseInputAmount(opts.amount)
  const inputAsset = parsed.asset
  const amountInRaw = parsed.raw

  const cfg = loadTradingConfig()
  const slippageBps = opts.slippageBps ?? cfg.defaultSlippageBps ?? 100

  const {
    executeEvmSwap,
    ensureErc20Approval,
    getErc20Decimals,
    makeEvmProvider,
    NATIVE_ETH,
    BASE_USDC,
    BASE_CHAIN_ID,
    resolveBaseRpcUrl,
    DEFAULT_BASE_PROTECTED_TIP_WEI,
  } = await import('./evm-trading.js')

  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)

  // Phase 4c — duplicate-position check is now per-wallet. Different cohort
  // wallets can each hold their own position in the same token.
  const existing = readPosition('base', opts.ca, signer.address)
  if (existing && existing.status === 'open') {
    throw new Error(
      `Position already open for ${opts.ca} on wallet ${signer.address}. Sell it before opening a new one (or use a different cohort wallet).`,
    )
  }
  // Re-entry on a previously closed position: archive the old file to
  // history/ before we write the new entry, so the prior trade's PnL and
  // sells aren't lost. Skipped on dry-run (read-only invariant).
  if (existing && existing.status === 'closed' && !opts.dryRun) {
    archiveClosedPosition(existing)
  }
  const rpcUrl = resolveBaseRpcUrl({
    rpcUrl: opts.rpcUrl,
    protectedExec: opts.protectedExec,
  })
  const provider = makeEvmProvider(rpcUrl)
  const connectedWallet = signer.wallet.connect(provider) as import('ethers').Wallet

  let tokenDecimals = 18
  try {
    tokenDecimals = await getErc20Decimals(provider, opts.ca)
  } catch {
    // Fall back to 18 if the contract doesn't expose `decimals()` (rare, but
    // happens for non-standard ERC20s). We persist what we have; downstream
    // display will be approximate.
  }

  // Phase 5d — protected execution bumps the EIP-1559 priority fee. Falls
  // back to the configured default when --protected is set without --tip.
  const priorityFeeWei = opts.protectedExec
    ? (opts.priorityFeeWei ?? DEFAULT_BASE_PROTECTED_TIP_WEI)
    : undefined

  const srcToken = inputAsset === 'USDC' ? BASE_USDC : NATIVE_ETH
  const srcDecimals = inputAsset === 'USDC' ? 6 : 18

  const swap = await executeEvmSwap({
    provider,
    wallet: connectedWallet,
    srcToken,
    destToken: opts.ca,
    srcAmount: amountInRaw,
    srcDecimals,
    destDecimals: tokenDecimals,
    slippageBps,
    chainId: BASE_CHAIN_ID,
    dryRun: opts.dryRun,
    priorityFeeWei,
    // USDC-input requires an ERC20 approval to the ParaSwap router on first
    // use of that token from this wallet. ETH-input has no approval step.
    onTxBuilt: inputAsset === 'USDC'
      ? async (txBlob) => {
          if (opts.dryRun) return
          // Approve the ParaSwap tokenTransferProxy (`spender`), not the
          // Augustus router (`to`). See note on EvmSwapParams.onTxBuilt.
          await ensureErc20Approval(
            connectedWallet,
            srcToken,
            txBlob.spender,
            BigInt(amountInRaw),
          )
        }
      : undefined,
  })

  const tokensOutRaw = swap.destAmount
  let tokensOutUi = 0
  try {
    tokensOutUi = Number(BigInt(tokensOutRaw)) / Math.pow(10, tokenDecimals)
  } catch {
    tokensOutUi = 0
  }
  const tokensOut = formatTokensHuman(tokensOutUi, 6)

  const nowIso = new Date().toISOString()
  const position: BasePositionFile = {
    chain: 'base',
    mint: opts.ca,
    wallet: signer.address,
    status: 'open',
    entry: {
      tx: swap.txHash,
      time: nowIso,
      amountIn: parsed.display,
      // Legacy field — populated only for ETH-funded entries.
      amountInRawWei: inputAsset === 'ETH' ? amountInRaw : '0',
      inputAsset,
      amountInRaw,
      tokensOut,
      tokensOutRaw,
      tokenDecimals,
      entryMcap: null,
      feeWei: swap.feeWei,
      slippageBpsUsed: slippageBps,
      protectedExec: !!opts.protectedExec,
      cohortId: opts.cohortId,
    },
    thesis: opts.thesis.trim(),
    exitPlan: {
      cut: opts.cut,
      takeProfit: opts.takeProfit,
      holdIf: opts.holdIf,
      trailingStop: opts.trailingStop,
      timeLimit: opts.timeLimit,
      thesisCheck: opts.thesisCheck,
    },
    monitorState: {
      peakUnrealizedPct: 0,
      peakAt: nowIso,
    },
    riskFlags: opts.riskFlags ?? [],
    sells: [],
    pnl: {
      unrealizedPct: 0,
      lastPricedAt: null,
      realized: { asset: inputAsset, amount: 0 },
      unrealized: { asset: inputAsset, amount: 0 },
    },
  }

  // Dry-run must be strictly read-only: simulated trades never touch live state.
  if (!opts.dryRun) writePosition(position)

  const summary = `${opts.dryRun ? '[dry-run] ' : ''}Bought ${tokensOut} ${opts.ca} for ${position.entry.amountIn} on Base.`

  return {
    positionPath: opts.dryRun
      ? `simulated:${opts.ca}`
      : positionPath('base', opts.ca, signer.address),
    txHash: swap.txHash,
    amountIn: position.entry.amountIn,
    // Legacy field — kept for back-compat in consumers; only meaningful for ETH-funded entries.
    amountInRawWei: inputAsset === 'ETH' ? amountInRaw : '0',
    tokensOut,
    tokensOutRaw,
    tokenDecimals,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
    protectedExec: !!opts.protectedExec,
    rpcUrl,
    inputAsset,
    summary,
  }
}

// ───────── sellBase ─────────

export interface SellBaseOpts {
  ca: string
  percent: number
  reason: string
  walletRef?: string
  passphrase?: string
  slippageBps?: number
  dryRun?: boolean
  rpcUrl?: string
  // Phase 5d
  protectedExec?: boolean
  priorityFeeWei?: bigint
}

export interface SellBaseResult {
  positionPath: string
  txHash: string
  tokensIn: string
  tokensInRaw: string
  positionStatus: 'open' | 'closed'
  wallet: string
  mint: string
  dryRun: boolean
  feeWei: string
  slippageBpsUsed: number
  approvalTxHash?: string
  protectedExec: boolean
  rpcUrl: string
  /** The asset this sell exited to (mirrors entry.inputAsset). */
  outputAsset: BaseInputAsset
  /**
   * Difference between book remaining (entry tokensOut − sold) and the actual
   * on-chain balance at sell time, in raw token units. Undefined when book and
   * chain agreed (normal case). When set, the sell amount was capped at the
   * on-chain balance, which avoids "SafeERC20: low-level call failed" reverts
   * on partial sells of a drifted position.
   */
  reconcileDriftRaw?: string
  /** Canonical, asset-tagged output. */
  output: AssetAmount
  /** Canonical, asset-tagged realized PnL for this sell. */
  realized: AssetPnl
  /** One-line human-readable summary; safe to print directly. */
  summary: string
}

export async function sellBase(opts: SellBaseOpts): Promise<SellBaseResult> {
  assertValidEvmAddress(opts.ca)
  if (!opts.reason?.trim()) throw new Error('Missing --reason')
  if (!(opts.percent > 0 && opts.percent <= 100)) {
    throw new Error(`--percent must be in (0, 100], got ${opts.percent}`)
  }

  const cfg = loadTradingConfig()
  const slippageBps = opts.slippageBps ?? cfg.defaultSlippageBps ?? 100

  const {
    executeEvmSwap,
    ensureErc20Approval,
    getErc20Balance,
    makeEvmProvider,
    NATIVE_ETH,
    BASE_USDC,
    BASE_CHAIN_ID,
    resolveBaseRpcUrl,
    DEFAULT_BASE_PROTECTED_TIP_WEI,
  } = await import('./evm-trading.js')

  // Phase 4c — resolve signer first so we can scope the position read.
  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)
  const position = readPosition('base', opts.ca, signer.address)
  if (!position) {
    throw new Error(
      `No Base position for ${opts.ca} owned by wallet ${signer.address}. Did you mean a different --wallet?`,
    )
  }
  if (position.status !== 'open') throw new Error(`Position ${opts.ca} is already closed`)

  // Exit symmetry — sell back to whatever asset was used to enter.
  const outputAsset = position.entry.inputAsset ?? 'ETH'
  const destToken = outputAsset === 'USDC' ? BASE_USDC : NATIVE_ETH
  const destDecimals = outputAsset === 'USDC' ? 6 : 18

  const rpcUrl = resolveBaseRpcUrl({
    rpcUrl: opts.rpcUrl,
    protectedExec: opts.protectedExec,
  })
  const provider = makeEvmProvider(rpcUrl)
  const connectedWallet = signer.wallet.connect(provider) as import('ethers').Wallet

  const priorityFeeWei = opts.protectedExec
    ? (opts.priorityFeeWei ?? DEFAULT_BASE_PROTECTED_TIP_WEI)
    : undefined

  // BigInt math: remaining = totalEntry - sumOfSells (in u256 raw)
  const totalRaw = BigInt(position.entry.tokensOutRaw)
  const soldRaw = position.sells.reduce((acc, s) => acc + BigInt(s.tokensInRaw), 0n)
  const remainingRawBook = totalRaw - soldRaw
  if (remainingRawBook <= 0n) throw new Error('No tokens remaining to sell.')

  // Reconcile book vs. on-chain balance. ParaSwap's safeTransferFrom will revert
  // ("SafeERC20: low-level call failed") if we ask for more than the wallet
  // actually holds. This can happen when:
  //   - the buy receipt parser missed a token-fee deduction
  //   - manual transfers happened off-platform
  //   - rounding drift on a fee-on-transfer token
  // Capping at `min(book, onchain)` makes partial sells robust and turns a
  // confusing low-level revert into "sell what we actually have".
  let onchainBalance: bigint
  if (opts.dryRun) {
    onchainBalance = remainingRawBook // skip RPC call in dry-run; trust book
  } else {
    try {
      onchainBalance = await getErc20Balance(provider, opts.ca, signer.address)
    } catch {
      onchainBalance = remainingRawBook // fall back to book if RPC fails
    }
  }
  const remainingRaw = onchainBalance < remainingRawBook ? onchainBalance : remainingRawBook
  const reconcileDriftRaw = remainingRawBook - remainingRaw // 0 when book ≤ chain
  if (remainingRaw <= 0n) {
    throw new Error(
      `No on-chain balance for ${opts.ca} on ${signer.address} (book says ${remainingRawBook.toString()} but chain says 0). ` +
      `Re-sync with \`palmyr wallet sync --chain base --wallet <ref>\` and inspect the position.`,
    )
  }

  // For 100% sells: take the entire on-chain balance directly (BigInt(100*100)/10000 = 1 is exact).
  // For partial sells: use percent of remainingRaw with BigInt math; truncation drops at most one wei.
  const percentScaled = BigInt(Math.round(opts.percent * 100))
  const tokensToSellRaw = (remainingRaw * percentScaled) / 10000n
  if (tokensToSellRaw <= 0n) {
    throw new Error(`Computed sell amount is zero (remaining=${remainingRaw}, percent=${opts.percent}).`)
  }

  let approvalTxHash: string | undefined

  const swap = await executeEvmSwap({
    provider,
    wallet: connectedWallet,
    srcToken: opts.ca,
    destToken,
    srcAmount: tokensToSellRaw.toString(),
    srcDecimals: position.entry.tokenDecimals,
    destDecimals,
    slippageBps,
    chainId: BASE_CHAIN_ID,
    dryRun: opts.dryRun,
    priorityFeeWei,
    onTxBuilt: async (txBlob) => {
      if (opts.dryRun) return // skip approval in dry-run
      // Approve the tokenTransferProxy reported by the price route. This is
      // the root cause of "SafeERC20: low-level call failed" on partial sells:
      // ParaSwap v6 pulls tokens through a separate proxy contract, not the
      // Augustus router at `to`.
      const result = await ensureErc20Approval(
        connectedWallet,
        opts.ca,
        txBlob.spender,
        tokensToSellRaw,
      )
      if (result.approved && result.txHash) approvalTxHash = result.txHash
    },
  })

  const outRaw = swap.destAmount
  const outDisplay = outputAsset === 'USDC'
    ? formatUsdcHuman(outRaw)
    : formatEthHuman(outRaw)
  const tokensInUi = Number(BigInt(tokensToSellRaw.toString())) / Math.pow(10, position.entry.tokenDecimals)
  const tokensInDisplay = formatTokensHuman(tokensInUi, 6)

  // Realized PnL in the position's input asset (ETH or USDC).
  // Entry cost = entry amount + gas fee (ETH-only — fee was paid in ETH at swap time;
  // for USDC entries we treat gas as small and ignore it in the USDC accounting).
  const entryRawStr = position.entry.amountInRaw ?? position.entry.amountInRawWei
  let realizedAmount: number
  const inputAsset = position.entry.inputAsset ?? 'ETH'
  if (inputAsset === 'ETH' && outputAsset === 'ETH') {
    const entryAmountWei = BigInt(entryRawStr)
    const entryFeeWei = BigInt(position.entry.feeWei ?? '0')
    const totalEntryCostWei = entryAmountWei + entryFeeWei
    const costWei = (totalEntryCostWei * tokensToSellRaw) / totalRaw
    const sellFeeWei = BigInt(swap.feeWei)
    const proceedsNetWei = BigInt(outRaw) - sellFeeWei
    const realizedWei = proceedsNetWei - costWei
    realizedAmount = Number(realizedWei) / 1e18
  } else if (inputAsset === 'USDC' && outputAsset === 'USDC') {
    // USDC in, USDC out — fees were ETH but we don't subtract them from USDC PnL.
    const entryUsdc = BigInt(entryRawStr)
    const costUsdc = (entryUsdc * tokensToSellRaw) / totalRaw
    const realized6 = BigInt(outRaw) - costUsdc
    realizedAmount = Number(realized6) / 1e6
  } else {
    // Mixed in/out (rare — shouldn't happen with symmetric exit). Best-effort.
    realizedAmount = 0
  }

  const nowIso = new Date().toISOString()
  position.sells.push({
    tx: swap.txHash,
    time: nowIso,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    percentRequested: opts.percent,
    reason: opts.reason.trim(),
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
    protectedExec: !!opts.protectedExec,
    outputAsset,
    output: { asset: outputAsset, raw: outRaw, display: outDisplay },
    realized: { asset: outputAsset, amount: realizedAmount },
  })

  const totalRealized = position.sells.reduce((a, s) => a + (s.realized?.amount ?? 0), 0)
  position.pnl.realized = { asset: position.entry.inputAsset ?? 'ETH', amount: totalRealized }

  // Position closes when (a) the user explicitly sold 100% — even if the
  // on-chain balance was less than the book amount due to drift — or (b) the
  // sum of recorded sells exceeds the book entry amount.
  const newSoldRaw = soldRaw + tokensToSellRaw
  const fullyExited =
    opts.percent >= 100 ||
    newSoldRaw + reconcileDriftRaw >= totalRaw
  if (fullyExited) {
    position.status = 'closed'
    position.pnl.unrealizedPct = 0
    position.pnl.unrealized = { asset: position.entry.inputAsset ?? 'ETH', amount: 0 }
  }

  // Dry-run must be strictly read-only: simulated sells never touch the live
  // position file (otherwise a simulation can "close" a real position).
  if (!opts.dryRun) writePosition(position)

  const realizedSign = realizedAmount >= 0 ? '+' : ''
  const realizedDigits = outputAsset === 'USDC' ? 6 : 8
  const summary = `${opts.dryRun ? '[dry-run] ' : ''}Sold ${tokensInDisplay} ${opts.ca} for ${outDisplay}; realized ${realizedSign}${realizedAmount.toFixed(realizedDigits)} ${outputAsset}; position ${position.status}.`

  return {
    positionPath: opts.dryRun
      ? `simulated:${opts.ca}`
      : positionPath('base', opts.ca, signer.address),
    txHash: swap.txHash,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    positionStatus: position.status,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
    approvalTxHash,
    protectedExec: !!opts.protectedExec,
    rpcUrl,
    outputAsset,
    reconcileDriftRaw: reconcileDriftRaw === 0n ? undefined : reconcileDriftRaw.toString(),
    output: { asset: outputAsset, raw: outRaw, display: outDisplay },
    realized: { asset: outputAsset, amount: realizedAmount },
    summary,
  }
}

// ───────── syncBase ─────────

export interface SyncBaseOpts {
  walletRef?: string
  passphrase?: string
  rpcUrl?: string
  slippageBpsForQuote?: number
}

export interface SyncBaseEntry {
  mint: string
  status: 'open' | 'closed'
  bookRaw: string
  onchainRaw: string
  drift: string | null
  unrealizedEth: number
  unrealizedPct: number
  note: string
}

export interface SyncBaseReport {
  wallet: string
  positions: SyncBaseEntry[]
}

export async function syncBase(opts: SyncBaseOpts = {}): Promise<SyncBaseReport> {
  const cfg = loadTradingConfig()
  const slippageBpsForQuote = opts.slippageBpsForQuote ?? 50

  const {
    fetchParaswapPrice,
    getErc20Balance,
    makeEvmProvider,
    NATIVE_ETH,
    BASE_USDC,
    BASE_CHAIN_ID,
    resolveBaseRpcUrl,
  } = await import('./evm-trading.js')

  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)
  const rpcUrl = resolveBaseRpcUrl({ rpcUrl: opts.rpcUrl })
  const provider = makeEvmProvider(rpcUrl)

  const positions = listPositions({
    chain: 'base',
    walletAddress: signer.address,
  })

  const report: SyncBaseEntry[] = []
  const nowIso = new Date().toISOString()

  for (const p of positions) {
    const onchainRaw = await getErc20Balance(provider, p.mint, signer.address)
    const totalRaw = BigInt(p.entry.tokensOutRaw)
    const soldRaw = p.sells.reduce((acc, s) => acc + BigInt(s.tokensInRaw), 0n)
    const bookRaw = totalRaw - soldRaw

    const drift =
      onchainRaw === bookRaw
        ? null
        : onchainRaw === 0n
          ? 'book-says-open-but-chain-empty'
          : `book=${bookRaw.toString()} chain=${onchainRaw.toString()}`

    let unrealizedEth = 0
    let unrealizedPct = 0
    let priceNote: string | null = null

    if (bookRaw > 0n && p.status === 'open') {
      try {
        const inputAsset = p.entry.inputAsset ?? 'ETH'
        const destToken = inputAsset === 'USDC' ? BASE_USDC : NATIVE_ETH
        const destDecimals = inputAsset === 'USDC' ? 6 : 18
        const route = await fetchParaswapPrice({
          srcToken: p.mint,
          destToken,
          amount: bookRaw.toString(),
          srcDecimals: p.entry.tokenDecimals,
          destDecimals,
          network: BASE_CHAIN_ID,
        })
        const quotedOut = BigInt(route.destAmount)
        const entryRawStr = p.entry.amountInRaw ?? p.entry.amountInRawWei
        // For ETH-funded: cost basis includes ETH-denominated gas. For USDC: gas was paid in ETH,
        // not USDC, so we don't subtract it from the USDC cost basis.
        const entryCost = inputAsset === 'ETH'
          ? BigInt(entryRawStr) + BigInt(p.entry.feeWei ?? '0')
          : BigInt(entryRawStr)
        const remainingCost = (entryCost * bookRaw) / totalRaw
        const diff = quotedOut - remainingCost
        const divisor = inputAsset === 'USDC' ? 1e6 : 1e18
        unrealizedEth = Number(diff) / divisor
        unrealizedPct = remainingCost > 0n
          ? (Number(diff) / Number(remainingCost)) * 100
          : 0
        p.pnl.unrealizedPct = unrealizedPct
        p.pnl.lastPricedAt = nowIso
        p.pnl.unrealized = { asset: p.entry.inputAsset ?? 'ETH', amount: unrealizedEth }
      } catch (e: any) {
        priceNote = `quote failed: ${e?.message ?? String(e)}`
      }
    } else {
      p.pnl.unrealizedPct = 0
      p.pnl.unrealized = { asset: p.entry.inputAsset ?? 'ETH', amount: 0 }
    }

    writePosition(p)

    const note = priceNote ?? drift ?? 'ok'
    report.push({
      mint: p.mint,
      status: p.status,
      bookRaw: bookRaw.toString(),
      onchainRaw: onchainRaw.toString(),
      drift,
      unrealizedEth,
      unrealizedPct,
      note,
    })
  }

  return { wallet: signer.address, positions: report }
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
  // Phase 2 — MEV protection
  protectedExec?: boolean
  autoSlippage?: boolean
  jitoTipLamports?: number
  // Phase 3.5 — additional triggers
  trailingStop?: string             // e.g., "20%"
  timeLimit?: string                // e.g., "24h"
  // Phase 7 — LLM thesis check interval (e.g., "6h"); pairs with daemon
  thesisCheck?: string
  // Phase 5b — target chain (defaults to 'solana' for back-compat)
  chain?: 'solana' | 'base'
  // Phase 4c — cohort buy tag (set by cohortBuy() for each per-wallet leg)
  cohortId?: string
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
  // Phase 2 additions
  feeLamports: number
  tipLamports: number
  slippageBpsUsed: number
  slippageSource: 'user' | 'dexscreener' | 'fallback'
  protectedExec: boolean
  forensics?: FillForensics
  // USDC-input awareness
  inputAsset: SolanaInputAsset
  /** One-line human-readable summary; safe to print directly. */
  summary: string
}

export async function buy(opts: BuyOpts): Promise<BuyResult> {
  const mintPk = assertValidMint(opts.ca)
  if (!opts.thesis?.trim()) throw new Error('Missing --thesis')

  // USDC-aware amount parsing: suffix on --amount picks the input asset.
  const parsed = parseSolanaInputAmount(opts.amount)
  const inputAsset = parsed.asset
  const amountInRaw = parsed.raw
  const inputMint = inputAsset === 'USDC' ? USDC_MINT_SOLANA : SOL_MINT.toBase58()

  const cfg = loadTradingConfig()
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl
  const quoteMaxAgeMs = cfg.quoteMaxAgeMs

  // Slippage: explicit --slippage > --auto-slippage / --protected > config default
  let slippageBps: number
  let slippageSource: 'user' | 'dexscreener' | 'fallback'
  if (opts.slippageBps !== undefined) {
    slippageBps = opts.slippageBps
    slippageSource = 'user'
  } else if (opts.autoSlippage || opts.protectedExec) {
    const rec = await recommendSlippageBps(opts.ca, cfg.defaultSlippageBps ?? 100)
    slippageBps = rec.bps
    slippageSource = rec.source
  } else {
    slippageBps = cfg.defaultSlippageBps ?? 100
    slippageSource = 'fallback'
  }

  // Jito tip is only set when --protected is on. Caller can override the default.
  const jitoTipLamports = opts.protectedExec
    ? (opts.jitoTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS)
    : undefined

  const signer = await resolveSigner(opts.walletRef, opts.passphrase)

  // Phase 4c — duplicate-position check is per-wallet. Different cohort
  // wallets can open simultaneous positions in the same token.
  const existing = readPosition('solana', opts.ca, signer.address)
  if (existing && existing.status === 'open') {
    throw new Error(
      `Position already open for ${opts.ca} on wallet ${signer.address}. Use \`palmyr wallet sell solana ${opts.ca} --wallet ${opts.walletRef ?? '<ref>'} --percent ...\` to exit first (or use a different cohort wallet).`,
    )
  }
  // Re-entry on a previously closed position: archive the old file to
  // history/ before we write the new entry, so the prior trade's PnL and
  // sells aren't lost. Skipped on dry-run (read-only invariant).
  if (existing && existing.status === 'closed' && !opts.dryRun) {
    archiveClosedPosition(existing)
  }

  const connection: Connection = makeConnection(rpcUrl)

  const swap = await executeSwap({
    connection,
    wallet: signer.keypair,
    inputMint,
    outputMint: mintPk.toBase58(),
    inputAmountRaw: amountInRaw,
    slippageBps,
    dryRun: opts.dryRun,
    quoteMaxAgeMs,
    jitoTipLamports,
  })

  const feeLamports = swap.feeLamports ?? 0
  const tipLamports = swap.tipLamports ?? 0
  const forensics: FillForensics | undefined = opts.dryRun
    ? undefined
    : analyzeFill(swap.quotedOutRaw, swap.outputAmountRaw, slippageBps)

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
      amountIn: parsed.display,
      // Keep legacy lamports field populated when SOL-funded; 0 otherwise.
      amountInRawSol: inputAsset === 'SOL' ? amountInRaw : 0,
      inputAsset,
      amountInRaw,
      tokensOut,
      tokensOutRaw,
      tokenDecimals,
      entryMcap,
      feeLamports,
      tipLamports,
      slippageBpsUsed: slippageBps,
      protectedExec: !!opts.protectedExec,
      cohortId: opts.cohortId,
    },
    thesis: opts.thesis.trim(),
    exitPlan: {
      cut: opts.cut,
      takeProfit: opts.takeProfit,
      holdIf: opts.holdIf,
      trailingStop: opts.trailingStop,
      timeLimit: opts.timeLimit,
      thesisCheck: opts.thesisCheck,
    },
    monitorState: {
      peakUnrealizedPct: 0,
      peakAt: nowIso,
    },
    riskFlags: opts.riskFlags ?? [],
    sells: [],
    pnl: {
      unrealizedPct: 0,
      lastPricedAt: null,
      realized: { asset: inputAsset, amount: 0 },
      unrealized: { asset: inputAsset, amount: 0 },
    },
  }

  // Dry-run is strictly read-only — never mutate live position state or the
  // append-only trade log. The simulated result is still returned to the caller.
  if (!opts.dryRun) {
    writePosition(position)
    appendTradeLog({
      kind: 'buy',
      ts: nowIso,
      chain: 'solana',
      wallet: signer.address,
      mint: opts.ca,
      tx: swap.txSignature,
      // For SOL-funded: actual SOL in. For USDC-funded: 0 (legacy log shape; keep semantics consistent).
      solIn: inputAsset === 'SOL' ? amountInRaw / 1e9 : 0,
      tokensOut,
      tokenDecimals,
      entryMcap,
      slippageBps,
      thesis: opts.thesis.trim(),
      protectedExec: !!opts.protectedExec,
      feeLamports,
      tipLamports,
      forensics,
    })
  }

  return {
    positionPath: opts.dryRun
      ? `simulated:${opts.ca}`
      : positionPath('solana', opts.ca, signer.address),
    txSignature: swap.txSignature,
    amountIn: position.entry.amountIn,
    amountInRawSol: inputAsset === 'SOL' ? amountInRaw : 0,
    tokensOut,
    tokensOutRaw,
    tokenDecimals,
    entryMcap,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeLamports,
    tipLamports,
    slippageBpsUsed: slippageBps,
    slippageSource,
    protectedExec: !!opts.protectedExec,
    forensics,
    inputAsset,
    summary: `${opts.dryRun ? '[dry-run] ' : ''}Bought ${tokensOut} ${opts.ca} for ${position.entry.amountIn} on Solana.`,
  }
}

// ───────── sell ─────────

export interface SellOpts {
  ca: string
  percent: number                   // 0 < p ≤ 100
  reason: string
  walletRef?: string
  passphrase?: string
  slippageBps?: number
  dryRun?: boolean
  rpcUrl?: string
  // Phase 2
  protectedExec?: boolean
  autoSlippage?: boolean
  jitoTipLamports?: number
}

export interface SellResult {
  positionPath: string
  txSignature: string
  tokensIn: string
  tokensInRaw: string
  positionStatus: 'open' | 'closed'
  wallet: string
  mint: string
  dryRun: boolean
  /** Asset this sell exited to (mirrors entry.inputAsset). */
  outputAsset: SolanaInputAsset
  // Phase 2
  feeLamports: number
  tipLamports: number
  slippageBpsUsed: number
  slippageSource: 'user' | 'dexscreener' | 'fallback'
  protectedExec: boolean
  forensics?: FillForensics
  /** Canonical, asset-tagged output. */
  output: AssetAmount
  /** Canonical, asset-tagged realized PnL for this sell. */
  realized: AssetPnl
  /** One-line human-readable summary; safe to print directly. */
  summary: string
}

export async function sell(opts: SellOpts): Promise<SellResult> {
  const mintPk = assertValidMint(opts.ca)
  if (!opts.reason?.trim()) throw new Error('Missing --reason')
  if (!(opts.percent > 0 && opts.percent <= 100)) {
    throw new Error(`--percent must be in (0, 100], got ${opts.percent}`)
  }

  const cfg = loadTradingConfig()
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl
  const quoteMaxAgeMs = cfg.quoteMaxAgeMs

  // Slippage: explicit --slippage > --auto-slippage / --protected > config default
  let slippageBps: number
  let slippageSource: 'user' | 'dexscreener' | 'fallback'
  if (opts.slippageBps !== undefined) {
    slippageBps = opts.slippageBps
    slippageSource = 'user'
  } else if (opts.autoSlippage || opts.protectedExec) {
    const rec = await recommendSlippageBps(opts.ca, cfg.defaultSlippageBps ?? 100)
    slippageBps = rec.bps
    slippageSource = rec.source
  } else {
    slippageBps = cfg.defaultSlippageBps ?? 100
    slippageSource = 'fallback'
  }

  const jitoTipLamports = opts.protectedExec
    ? (opts.jitoTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS)
    : undefined

  // Phase 4c — resolve signer first so we can scope the position read.
  const signer = await resolveSigner(opts.walletRef, opts.passphrase)
  const position = readPosition('solana', opts.ca, signer.address)
  if (!position) {
    throw new Error(
      `No position for ${opts.ca} owned by wallet ${signer.address}. Did you mean a different --wallet?`,
    )
  }
  if (position.status !== 'open') throw new Error(`Position ${opts.ca} is already closed`)

  const connection: Connection = makeConnection(rpcUrl)

  // FIFO remaining = totalEntry - sumOfSells (in raw u64)
  const totalRaw = BigInt(position.entry.tokensOutRaw)
  const soldRaw = position.sells.reduce(
    (acc, s) => acc + BigInt(s.tokensInRaw),
    0n,
  )
  const remainingRaw = totalRaw - soldRaw
  if (remainingRaw <= 0n) throw new Error('No tokens remaining to sell.')

  // BigInt-safe sizing: percent×100 ÷ 10000
  const percentScaled = BigInt(Math.round(opts.percent * 100))
  const tokensToSellRaw = (remainingRaw * percentScaled) / 10000n
  if (tokensToSellRaw <= 0n) {
    throw new Error(`Computed sell amount is zero (remaining=${remainingRaw}, percent=${opts.percent}).`)
  }

  // Exit symmetry: sell back to the same asset the position was opened in.
  const outputAsset = position.entry.inputAsset ?? 'SOL'
  const outputMint = outputAsset === 'USDC' ? USDC_MINT_SOLANA : SOL_MINT.toBase58()
  const outputDecimals = outputAsset === 'USDC' ? 6 : 9

  const swap = await executeSwap({
    connection,
    wallet: signer.keypair,
    inputMint: mintPk.toBase58(),
    outputMint,
    inputAmountRaw: Number(tokensToSellRaw),
    slippageBps,
    dryRun: opts.dryRun,
    quoteMaxAgeMs,
    jitoTipLamports,
  })

  const solOutRaw = swap.outputAmountRaw          // raw output in `outputAsset` units (gross — fee+tip added back)
  const feeLamports = swap.feeLamports ?? 0
  const tipLamports = swap.tipLamports ?? 0
  const tokensInUi = Number(tokensToSellRaw) / Math.pow(10, position.entry.tokenDecimals)
  const tokensInDisplay = formatTokensHuman(tokensInUi, 6)
  const solOutDisplay = outputAsset === 'USDC'
    ? formatUsdcHuman(solOutRaw)
    : formatSolHuman(solOutRaw, 6)

  // FIFO realized PnL in the position's input asset (SOL or USDC).
  //   entryCost = entry amount + entry fee + entry tip (all in input asset units)
  //     - USDC entries: fees were paid in SOL at swap time, so they don't reduce
  //       the USDC cost basis. We treat entryCost as purely the USDC spent.
  //   netProceeds = gross out - sell fee/tip (SOL-paid) when output is SOL;
  //     for USDC output, fees were paid in SOL so we don't subtract from USDC out.
  const entryAssetRaw = position.entry.amountInRaw ?? position.entry.amountInRawSol
  const proportion = Number(tokensToSellRaw) / Number(totalRaw)
  let realizedSol: number
  let netProceedsForLog: number
  if (outputAsset === 'SOL') {
    const entryFee = position.entry.feeLamports ?? 0
    const entryTip = position.entry.tipLamports ?? 0
    const entryCostLamports = entryAssetRaw + entryFee + entryTip
    const entryCostSol = entryCostLamports / 1e9
    const costSol = proportion * entryCostSol
    const netProceedsSol = (solOutRaw - feeLamports - tipLamports) / 1e9
    realizedSol = netProceedsSol - costSol
    netProceedsForLog = netProceedsSol
  } else {
    // USDC: entry raw is in 6-decimal USDC units. Sell proceeds also in USDC.
    const entryCostUsdc = entryAssetRaw / 1e6
    const costUsdc = proportion * entryCostUsdc
    const netProceedsUsdc = solOutRaw / 1e6
    realizedSol = netProceedsUsdc - costUsdc
    netProceedsForLog = netProceedsUsdc
  }

  const forensics: FillForensics | undefined = opts.dryRun
    ? undefined
    : analyzeFill(swap.quotedOutRaw, swap.outputAmountRaw, slippageBps)

  const nowIso = new Date().toISOString()
  position.sells.push({
    tx: swap.txSignature,
    time: nowIso,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    percentRequested: opts.percent,
    reason: opts.reason.trim(),
    feeLamports,
    tipLamports,
    slippageBpsUsed: slippageBps,
    protectedExec: !!opts.protectedExec,
    forensics,
    outputAsset,
    output: { asset: outputAsset, raw: String(solOutRaw), display: solOutDisplay },
    realized: { asset: outputAsset, amount: realizedSol },
  })

  const totalRealized = position.sells.reduce((a, s) => a + (s.realized?.amount ?? 0), 0)
  position.pnl.realized = { asset: position.entry.inputAsset ?? 'SOL', amount: totalRealized }

  const newSoldRaw = soldRaw + tokensToSellRaw
  if (newSoldRaw >= totalRaw) {
    position.status = 'closed'
    position.pnl.unrealizedPct = 0
    position.pnl.unrealized = { asset: position.entry.inputAsset ?? 'SOL', amount: 0 }
  }

  // Dry-run is strictly read-only — never mutate live position state or the
  // append-only trade log. The simulated result is still returned to the caller.
  if (!opts.dryRun) {
    writePosition(position)
    appendTradeLog({
      kind: 'sell',
      ts: nowIso,
      chain: 'solana',
      wallet: signer.address,
      mint: opts.ca,
      tx: swap.txSignature,
      tokensIn: tokensInDisplay,
      solOut: netProceedsForLog,
      percentRequested: opts.percent,
      realizedSol,
      reason: opts.reason.trim(),
      protectedExec: !!opts.protectedExec,
      feeLamports,
      tipLamports,
      forensics,
    })
  }

  const sign = realizedSol >= 0 ? '+' : ''
  const digits = outputAsset === 'USDC' ? 6 : 8
  const summary = `${opts.dryRun ? '[dry-run] ' : ''}Sold ${tokensInDisplay} ${opts.ca} for ${solOutDisplay}; realized ${sign}${realizedSol.toFixed(digits)} ${outputAsset}; position ${position.status}.`

  return {
    positionPath: opts.dryRun
      ? `simulated:${opts.ca}`
      : positionPath('solana', opts.ca, signer.address),
    txSignature: swap.txSignature,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    positionStatus: position.status,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeLamports,
    tipLamports,
    slippageBpsUsed: slippageBps,
    slippageSource,
    protectedExec: !!opts.protectedExec,
    forensics,
    outputAsset,
    output: { asset: outputAsset, raw: String(solOutRaw), display: solOutDisplay },
    realized: { asset: outputAsset, amount: realizedSol },
    summary,
  }
}

// ───────── sync ─────────

export interface SyncOpts {
  walletRef?: string
  passphrase?: string
  rpcUrl?: string
  slippageBpsForQuote?: number      // default 50 bps for price reads
}

export interface SyncEntry {
  mint: string
  status: 'open' | 'closed'
  bookRaw: string
  onchainRaw: string
  drift: string | null              // null when book == chain
  unrealizedSol: number
  unrealizedPct: number
  note: string
}

export interface SyncReport {
  wallet: string
  positions: SyncEntry[]
}

export async function sync(opts: SyncOpts = {}): Promise<SyncReport> {
  const cfg = loadTradingConfig()
  const rpcUrl = opts.rpcUrl ?? cfg.rpcUrl
  const slippageBpsForQuote = opts.slippageBpsForQuote ?? 50

  const signer = await resolveSigner(opts.walletRef, opts.passphrase)
  const owner = signer.keypair.publicKey
  const connection: Connection = makeConnection(rpcUrl)

  const positions = listPositions({
    chain: 'solana',
    walletAddress: signer.address,
  })

  const report: SyncEntry[] = []
  const nowIso = new Date().toISOString()

  for (const p of positions) {
    const onchain = await getSplTokenBalance(connection, owner, new PublicKey(p.mint))
    const totalRaw = BigInt(p.entry.tokensOutRaw)
    const soldRaw = p.sells.reduce((acc, s) => acc + BigInt(s.tokensInRaw), 0n)
    const bookRaw = totalRaw - soldRaw
    const onchainRaw = onchain.raw

    const drift =
      onchainRaw === bookRaw
        ? null
        : onchainRaw === 0n
          ? 'book-says-open-but-chain-empty'
          : `book=${bookRaw.toString()} chain=${onchainRaw.toString()}`

    let unrealizedSol = 0
    let unrealizedPct = 0
    let priceNote: string | null = null

    if (bookRaw > 0n && p.status === 'open') {
      try {
        // Quote token → position's input asset (SOL or USDC).
        const inputAsset = p.entry.inputAsset ?? 'SOL'
        const outputMint = inputAsset === 'USDC' ? USDC_MINT_SOLANA : SOL_MINT.toBase58()
        const q = await fetchQuote({
          inputMint: p.mint,
          outputMint,
          amount: Number(bookRaw),
          slippageBps: slippageBpsForQuote,
        })
        const entryAssetRaw = p.entry.amountInRaw ?? p.entry.amountInRawSol
        if (inputAsset === 'SOL') {
          const solOut = Number(q.outAmount) / 1e9
          const entrySol = entryAssetRaw / 1e9
          const proportion = Number(bookRaw) / Number(totalRaw)
          const remCost = proportion * entrySol
          unrealizedSol = solOut - remCost
          unrealizedPct = remCost > 0 ? (unrealizedSol / remCost) * 100 : 0
        } else {
          const usdcOut = Number(q.outAmount) / 1e6
          const entryUsdc = entryAssetRaw / 1e6
          const proportion = Number(bookRaw) / Number(totalRaw)
          const remCost = proportion * entryUsdc
          unrealizedSol = usdcOut - remCost          // field name kept; holds USDC realized for USDC positions
          unrealizedPct = remCost > 0 ? (unrealizedSol / remCost) * 100 : 0
        }
        p.pnl.unrealizedPct = unrealizedPct
        p.pnl.lastPricedAt = nowIso
        p.pnl.unrealized = { asset: p.entry.inputAsset ?? 'SOL', amount: unrealizedSol }
      } catch (e: any) {
        priceNote = `quote failed: ${e.message}`
      }
    } else {
      p.pnl.unrealizedPct = 0
      p.pnl.unrealized = { asset: p.entry.inputAsset ?? 'SOL', amount: 0 }
    }

    writePosition(p)

    const note = priceNote ?? drift ?? 'ok'
    appendTradeLog({
      kind: 'sync',
      ts: nowIso,
      chain: 'solana',
      wallet: signer.address,
      mint: p.mint,
      drift: drift
        ? { onchain: onchainRaw.toString(), book: bookRaw.toString() }
        : null,
      note,
    })

    report.push({
      mint: p.mint,
      status: p.status,
      bookRaw: bookRaw.toString(),
      onchainRaw: onchainRaw.toString(),
      drift,
      unrealizedSol,
      unrealizedPct,
      note,
    })
  }

  return { wallet: signer.address, positions: report }
}

// ───────── cohort buy (Phase 4c) ─────────

/**
 * Phase 4c — split a single trade decision across N derived wallets with
 * random jitter between legs. Each per-wallet buy produces its own position
 * file under that wallet's directory. Failures are captured per-leg; we don't
 * roll back successes.
 *
 * The cohort is sequential by design: parallel would race the same RPC quote
 * and could trigger pool-impact penalties on the second-into-the-block leg.
 * Sequential + jitter gives the same effect with predictable failure modes.
 */
export interface CohortBuyOpts {
  chain: 'solana' | 'base'
  ca: string
  totalAmount: string                 // e.g. "1.0sol", "0.05eth"
  walletRefs: string[]                // ['trading:0', 'trading:1', ...]
  thesis: string
  /** Random delay in ms between each leg, sampled from [0, jitterMs]. Skipped when dryRun. */
  jitterMs?: number
  cut?: string
  takeProfit?: string
  holdIf?: string
  trailingStop?: string
  timeLimit?: string
  thesisCheck?: string
  riskFlags?: string[]
  passphrase?: string
  slippageBps?: number
  dryRun?: boolean
  rpcUrl?: string
  // Solana protection flags
  protectedExec?: boolean
  autoSlippage?: boolean
  jitoTipLamports?: number
  // Base protection flags
  priorityFeeWei?: bigint
}

export type CohortLegSuccess =
  | { walletRef: string; status: 'ok'; chain: 'solana'; result: BuyResult }
  | { walletRef: string; status: 'ok'; chain: 'base'; result: BuyBaseResult }

export interface CohortLegFailure {
  walletRef: string
  status: 'failed'
  error: string
  /** ms spent on this leg (incl. jitter). */
  elapsedMs?: number
}

export interface CohortBuyResult {
  cohortId: string
  chain: 'solana' | 'base'
  ca: string
  totalRequested: string
  perWalletAmount: string
  successes: CohortLegSuccess[]
  failures: CohortLegFailure[]
  startedAt: string
  finishedAt: string
}

function randomCohortId(): string {
  // human-readable but unique enough for one cohort per minute
  const ts = Date.now().toString(36)
  const rand = randomBytes(2).toString('hex')
  return `cohort-${ts}-${rand}`
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Solana amount split. Auto-detects asset (SOL or USDC) from the total's suffix.
 * Per-leg amount is `floor(total / n)`; remainder is silently dropped (at most
 * n-1 base units, negligible at typical cohort sizes).
 */
function splitSolAmount(totalAmount: string, n: number): string {
  const parsed = parseSolanaInputAmount(totalAmount)
  const perLeg = Math.floor(parsed.raw / n)
  if (perLeg <= 0) {
    throw new Error(`Cohort split: per-leg amount is 0 (total=${parsed.raw} ${parsed.asset} raw, n=${n}). Increase --total or reduce wallet count.`)
  }
  if (parsed.asset === 'SOL') {
    return `${(perLeg / 1e9).toFixed(9)}sol`
  }
  return `${(perLeg / 1e6).toFixed(6)}usdc`
}

/**
 * Base amount split. Auto-detects asset (ETH or USDC) from total's suffix.
 * Returns per-leg in the asset's canonical raw suffix so `buyBase` round-trips
 * without float drift.
 */
function splitEthAmount(totalAmount: string, n: number): string {
  const parsed = parseBaseInputAmount(totalAmount)
  const totalRaw = BigInt(parsed.raw)
  const perLeg = totalRaw / BigInt(n)
  if (perLeg <= 0n) {
    throw new Error(`Cohort split: per-leg amount is 0 raw (total=${totalRaw} ${parsed.asset}, n=${n}). Increase --total or reduce wallet count.`)
  }
  if (parsed.asset === 'ETH') {
    return `${perLeg.toString()}wei`
  }
  // USDC: emit as decimal "Nusdc" since `Nusdc` parser handles fractional values.
  // Use 6-decimal representation; BigInt division is integer-exact at the raw level.
  const whole = perLeg / 1_000_000n
  const frac = (perLeg % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${frac}usdc`
}

export async function cohortBuy(opts: CohortBuyOpts): Promise<CohortBuyResult> {
  if (!opts.thesis?.trim()) throw new Error('Missing --thesis')
  if (opts.walletRefs.length === 0) throw new Error('Cohort needs at least one wallet (--wallets or --from + --split).')
  const cohortId = randomCohortId()
  const startedAt = new Date().toISOString()

  const perWalletAmount = opts.chain === 'solana'
    ? splitSolAmount(opts.totalAmount, opts.walletRefs.length)
    : splitEthAmount(opts.totalAmount, opts.walletRefs.length)

  const successes: CohortLegSuccess[] = []
  const failures: CohortLegFailure[] = []
  const jitter = Math.max(0, opts.jitterMs ?? 0)

  for (let i = 0; i < opts.walletRefs.length; i++) {
    const walletRef = opts.walletRefs[i]
    const legStart = Date.now()
    try {
      // Apply jitter for all but the first leg (we want the first to fire
      // immediately so the cohort feels responsive).
      if (i > 0 && jitter > 0 && !opts.dryRun) {
        const wait = Math.floor(Math.random() * jitter)
        await delay(wait)
      }
      if (opts.chain === 'solana') {
        const result = await buy({
          ca: opts.ca,
          amount: perWalletAmount,
          thesis: opts.thesis,
          cut: opts.cut,
          takeProfit: opts.takeProfit,
          holdIf: opts.holdIf,
          trailingStop: opts.trailingStop,
          timeLimit: opts.timeLimit,
          thesisCheck: opts.thesisCheck,
          riskFlags: opts.riskFlags,
          walletRef,
          passphrase: opts.passphrase,
          slippageBps: opts.slippageBps,
          dryRun: opts.dryRun,
          rpcUrl: opts.rpcUrl,
          protectedExec: opts.protectedExec,
          autoSlippage: opts.autoSlippage,
          jitoTipLamports: opts.jitoTipLamports,
          cohortId,
        })
        successes.push({ walletRef, status: 'ok', chain: 'solana', result })
      } else {
        const result = await buyBase({
          ca: opts.ca,
          amount: perWalletAmount,
          thesis: opts.thesis,
          cut: opts.cut,
          takeProfit: opts.takeProfit,
          holdIf: opts.holdIf,
          trailingStop: opts.trailingStop,
          timeLimit: opts.timeLimit,
          thesisCheck: opts.thesisCheck,
          riskFlags: opts.riskFlags,
          walletRef,
          passphrase: opts.passphrase,
          slippageBps: opts.slippageBps,
          dryRun: opts.dryRun,
          rpcUrl: opts.rpcUrl,
          protectedExec: opts.protectedExec,
          priorityFeeWei: opts.priorityFeeWei,
          cohortId,
        })
        successes.push({ walletRef, status: 'ok', chain: 'base', result })
      }
    } catch (e: any) {
      failures.push({
        walletRef,
        status: 'failed',
        error: e?.message ?? String(e),
        elapsedMs: Date.now() - legStart,
      })
    }
  }

  return {
    cohortId,
    chain: opts.chain,
    ca: opts.ca,
    totalRequested: opts.totalAmount,
    perWalletAmount,
    successes,
    failures,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

// ───────── pnl ─────────

export interface PnlOpts {
  by?: 'wallet' | 'chain'
  sinceIso?: string
  includeClosed?: boolean
  /**
   * Phase 5d — when true (default), fetch SOL/USD + ETH/USD spot prices and
   * compute cross-chain USD totals. Set to false in tests or to suppress the
   * extra API calls. Falls back gracefully if the price lookups fail.
   */
  usd?: boolean
}

export interface PnlPerChain {
  realized: number                    // native unit (SOL or ETH)
  unrealized: number
  total: number
  count: number
  unit: 'SOL' | 'ETH'
}

export interface PnlUsdcBucket {
  realized: number                    // USDC (already 1:1 with USD)
  unrealized: number
  total: number
  count: number
}

export interface PnlUsdSection {
  realized: number
  unrealized: number
  total: number
  solPriceUsd: number | null
  ethPriceUsd: number | null
}

export interface PnlByGroupEntry {
  /** Group key (wallet address or chain name). */
  key: string
  /** Realized in native unit. */
  realized: number
  unrealized: number
  count: number
  /** Native unit for this group ('SOL', 'ETH', or 'USDC'). */
  unit: 'SOL' | 'ETH' | 'USDC'
  /** Chain (always set; for `--by chain` it equals the group key). */
  chain: 'solana' | 'base'
}

export interface PnlReport {
  // Per-chain breakdown in native units (only counts native-funded positions)
  solana: PnlPerChain
  base: PnlPerChain
  // USDC-funded positions aggregated across chains
  usdc: PnlUsdcBucket
  // Cross-chain USD aggregation (null if all price lookups failed AND no USDC positions)
  usd: PnlUsdSection | null
  // Grouping when --by is set
  byGroup?: PnlByGroupEntry[]
  // Back-compat (Phase 1-5c consumers depend on these field names)
  totalRealizedSol: number
  totalUnrealizedSol: number
  totalSol: number
  count: number
}

export async function computePnl(opts: PnlOpts = {}): Promise<PnlReport> {
  const includeClosed = opts.includeClosed ?? true
  const livePositions = listPositions({ includeClosed })
  // Archived closed positions (re-entries on the same mint after close) need
  // to be counted toward historical PnL — without this, repeated buys of the
  // same token would lose every closed cycle except the most recent.
  const historicalPositions = includeClosed ? listHistoricalPositions() : []
  const positions = [...livePositions, ...historicalPositions]
  const filtered = opts.sinceIso
    ? positions.filter((p) => p.entry.time >= opts.sinceIso!)
    : positions

  const solanaPositions = filtered.filter(
    (p): p is SolanaPositionFile => p.chain === 'solana',
  )
  const basePositions = filtered.filter(
    (p): p is BasePositionFile => p.chain === 'base',
  )

  // ── Per-asset totals — bucket by inputAsset, not by chain ──
  let solRealized = 0, solUnrealized = 0, solCount = 0
  let ethRealized = 0, ethUnrealized = 0, ethCount = 0
  let usdcRealized = 0, usdcUnrealized = 0, usdcCount = 0

  for (const p of solanaPositions) {
    const asset = p.entry.inputAsset ?? 'SOL'
    const realized = p.pnl.realized?.amount ?? 0
    const unrealized = p.pnl.unrealized?.amount ?? 0
    if (asset === 'USDC') {
      usdcRealized += realized
      usdcUnrealized += unrealized
      usdcCount += 1
    } else {
      solRealized += realized
      solUnrealized += unrealized
      solCount += 1
    }
  }
  for (const p of basePositions) {
    const asset = p.entry.inputAsset ?? 'ETH'
    const realized = p.pnl.realized?.amount ?? 0
    const unrealized = p.pnl.unrealized?.amount ?? 0
    if (asset === 'USDC') {
      usdcRealized += realized
      usdcUnrealized += unrealized
      usdcCount += 1
    } else {
      ethRealized += realized
      ethUnrealized += unrealized
      ethCount += 1
    }
  }

  // ── USD conversion ──
  let usdSection: PnlUsdSection | null = null
  const wantUsd = opts.usd ?? true
  if (wantUsd) {
    const { fetchUsdPrice } = await import('./evm-trading.js')
    const needsSol = solCount > 0
    const needsEth = ethCount > 0
    const [solPrice, ethPrice] = await Promise.all([
      needsSol ? fetchUsdPrice('SOL') : Promise.resolve(null),
      needsEth ? fetchUsdPrice('ETH') : Promise.resolve(null),
    ])
    const haveAnyPrice = solPrice !== null || ethPrice !== null || usdcCount > 0
    if (haveAnyPrice) {
      const solR = solPrice !== null ? solRealized * solPrice : 0
      const solU = solPrice !== null ? solUnrealized * solPrice : 0
      const ethR = ethPrice !== null ? ethRealized * ethPrice : 0
      const ethU = ethPrice !== null ? ethUnrealized * ethPrice : 0
      // USDC = USD 1:1 by definition.
      usdSection = {
        realized: solR + ethR + usdcRealized,
        unrealized: solU + ethU + usdcUnrealized,
        total: solR + solU + ethR + ethU + usdcRealized + usdcUnrealized,
        solPriceUsd: solPrice,
        ethPriceUsd: ethPrice,
      }
    }
  }

  // ── Grouping ──
  let byGroup: PnlByGroupEntry[] | undefined
  if (opts.by) {
    const map = new Map<string, PnlByGroupEntry>()
    const bucketKey = (p: PositionFile, asset: 'SOL' | 'ETH' | 'USDC') => {
      if (opts.by === 'wallet') return `${p.wallet}|${asset}`
      // by chain: split USDC out as its own bucket since it crosses chains
      return asset === 'USDC' ? 'usdc' : p.chain
    }
    for (const p of solanaPositions) {
      const asset: 'SOL' | 'USDC' = p.entry.inputAsset ?? 'SOL'
      const key = bucketKey(p, asset)
      let entry = map.get(key)
      if (!entry) {
        const displayKey = opts.by === 'wallet' ? p.wallet : key
        entry = { key: displayKey, realized: 0, unrealized: 0, count: 0, unit: asset, chain: 'solana' }
        map.set(key, entry)
      }
      entry.realized += p.pnl.realized?.amount ?? 0
      entry.unrealized += p.pnl.unrealized?.amount ?? 0
      entry.count += 1
    }
    for (const p of basePositions) {
      const asset: 'ETH' | 'USDC' = p.entry.inputAsset ?? 'ETH'
      const key = bucketKey(p, asset)
      let entry = map.get(key)
      if (!entry) {
        const displayKey = opts.by === 'wallet' ? p.wallet : key
        entry = { key: displayKey, realized: 0, unrealized: 0, count: 0, unit: asset, chain: 'base' }
        map.set(key, entry)
      }
      entry.realized += p.pnl.realized?.amount ?? 0
      entry.unrealized += p.pnl.unrealized?.amount ?? 0
      entry.count += 1
    }
    byGroup = Array.from(map.values())
  }

  const solana: PnlPerChain = {
    realized: solRealized,
    unrealized: solUnrealized,
    total: solRealized + solUnrealized,
    count: solCount,
    unit: 'SOL',
  }
  const base: PnlPerChain = {
    realized: ethRealized,
    unrealized: ethUnrealized,
    total: ethRealized + ethUnrealized,
    count: ethCount,
    unit: 'ETH',
  }
  const usdc: PnlUsdcBucket = {
    realized: usdcRealized,
    unrealized: usdcUnrealized,
    total: usdcRealized + usdcUnrealized,
    count: usdcCount,
  }

  return {
    solana,
    base,
    usdc,
    usd: usdSection,
    byGroup,
    // Back-compat fields — still describe the Solana totals as in Phase 1-5c.
    totalRealizedSol: solRealized,
    totalUnrealizedSol: solUnrealized,
    totalSol: solRealized + solUnrealized,
    count: solanaPositions.length,
  }
}
