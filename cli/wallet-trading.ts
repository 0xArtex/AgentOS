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
} from '@palmyr/solana-trading'

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
    join(TRADING_DIR, 'positions', 'base'),
    join(TRADING_DIR, 'journal'),
  ]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

export function positionPath(chain: 'solana' | 'base', mint: string) {
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
}

export interface SolanaEntry {
  tx: string
  time: string
  amountIn: string                    // e.g. "0.5 SOL"
  amountInRawSol: number              // lamports (number — fits in JS Number for SOL)
  tokensOut: string
  tokensOutRaw: string                // raw u64 as decimal string
  tokenDecimals: number
  entryMcap: number | null
  feeLamports?: number
  tipLamports?: number
  slippageBpsUsed?: number
  protectedExec?: boolean
}

export interface SolanaSell {
  tx: string
  time: string
  tokensIn: string
  tokensInRaw: string
  solOut: string
  solOutRaw: number                   // lamports
  percentRequested: number
  realizedSol: number
  reason: string
  feeLamports?: number
  tipLamports?: number
  slippageBpsUsed?: number
  protectedExec?: boolean
  forensics?: FillForensics
}

export interface SolanaPnl {
  realizedSol: number
  unrealizedSol: number
  unrealizedPct: number
  lastPricedAt: string | null
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
  amountIn: string                    // e.g. "0.01 ETH"
  amountInRawWei: string              // u256 wei (string)
  tokensOut: string
  tokensOutRaw: string                // u256 raw token units
  tokenDecimals: number
  entryMcap: number | null
  feeWei?: string                     // u256 gas fee paid
  /** Phase 5b lite: protected execution on Base (Flashbots) is deferred to 5c. */
  slippageBpsUsed?: number
  protectedExec?: boolean
}

export interface BaseSell {
  tx: string
  time: string
  tokensIn: string
  tokensInRaw: string                 // u256 raw token units
  ethOut: string                      // display, e.g. "0.005 ETH"
  ethOutRawWei: string                // u256 wei received
  percentRequested: number
  realizedEth: number                 // small enough to fit in number for typical positions
  reason: string
  feeWei?: string
  slippageBpsUsed?: number
  protectedExec?: boolean
  forensics?: FillForensics
}

export interface BasePnl {
  realizedEth: number
  unrealizedEth: number
  unrealizedPct: number
  lastPricedAt: string | null
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
      chain: 'solana'
      wallet: string
      mint: string
      trigger: 'cut' | 'takeProfit' | 'trailingStop' | 'timeLimit' | 'thesis_falsified'
      currentPct: number
      thresholdPct?: number           // cut/takeProfit/trailingStop
      peakPct?: number                // trailingStop
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

export function writePosition(p: PositionFile) {
  ensureTradingDirs()
  atomicWriteFile(positionPath(p.chain, p.mint), JSON.stringify(p, null, 2))
}

export function readPosition(chain: 'solana', mint: string): SolanaPositionFile | null
export function readPosition(chain: 'base', mint: string): BasePositionFile | null
export function readPosition(chain: 'solana' | 'base', mint: string): PositionFile | null
export function readPosition(chain: 'solana' | 'base', mint: string): PositionFile | null {
  const p = positionPath(chain, mint)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PositionFile
  } catch {
    return null
  }
}

export interface PositionsFilter {
  chain?: 'solana' | 'base'
  walletAddress?: string
  includeClosed?: boolean
}

export function listPositions(filter: { chain: 'solana'; walletAddress?: string; includeClosed?: boolean }): SolanaPositionFile[]
export function listPositions(filter: { chain: 'base'; walletAddress?: string; includeClosed?: boolean }): BasePositionFile[]
export function listPositions(filter?: PositionsFilter): PositionFile[]
export function listPositions(filter: PositionsFilter = {}): PositionFile[] {
  ensureTradingDirs()
  const chains: Array<'solana' | 'base'> = filter.chain
    ? [filter.chain]
    : ['solana', 'base']
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

export function formatEthHuman(weiStr: string, decimals = 6): string {
  const wei = BigInt(weiStr)
  const whole = wei / 10n ** 18n
  const frac = wei % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals)
  return `${whole}.${fracStr} ETH`
}

// ───────── EVM signer resolver ─────────

export interface ResolvedEvmSigner {
  /** ethers.Wallet without a provider attached. Caller does `.connect(provider)`. */
  wallet: import('ethers').Wallet
  address: string
  source: 'trading-keystore'
  keystoreIndex: number
}

/**
 * Phase 5b — resolve `--wallet trading:N` to an EVM wallet. No env keypair
 * fallback for EVM (yet) — Phase 5c can add one if needed.
 */
export async function resolveEvmSigner(
  walletRef?: string,
  passphrase?: string,
): Promise<ResolvedEvmSigner> {
  if (!walletRef?.startsWith('trading:')) {
    throw new Error('For Base, --wallet must be a keystore reference like `trading:0`.')
  }
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
}

export async function buyBase(opts: BuyBaseOpts): Promise<BuyBaseResult> {
  assertValidEvmAddress(opts.ca)
  if (!opts.thesis?.trim()) throw new Error('Missing --thesis')
  const amountInRawWei = parseEvmAmount(opts.amount)

  const existing = readPosition('base', opts.ca)
  if (existing && existing.status === 'open') {
    throw new Error(
      `Position already open for ${opts.ca}. Sell it (Phase 5c will add CLI sell on Base; for now use Phantom or Coinbase Wallet) before opening a new one.`,
    )
  }

  const cfg = loadTradingConfig()
  const slippageBps = opts.slippageBps ?? cfg.defaultSlippageBps ?? 100

  const {
    executeEvmSwap,
    getErc20Decimals,
    makeEvmProvider,
    NATIVE_ETH,
    BASE_CHAIN_ID,
    DEFAULT_BASE_RPC,
  } = await import('./evm-trading.js')

  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)
  const provider = makeEvmProvider(opts.rpcUrl ?? DEFAULT_BASE_RPC)
  const connectedWallet = signer.wallet.connect(provider) as import('ethers').Wallet

  let tokenDecimals = 18
  try {
    tokenDecimals = await getErc20Decimals(provider, opts.ca)
  } catch {
    // Fall back to 18 if the contract doesn't expose `decimals()` (rare, but
    // happens for non-standard ERC20s). We persist what we have; downstream
    // display will be approximate.
  }

  const swap = await executeEvmSwap({
    provider,
    wallet: connectedWallet,
    srcToken: NATIVE_ETH,
    destToken: opts.ca,
    srcAmount: amountInRawWei,
    srcDecimals: 18,
    destDecimals: tokenDecimals,
    slippageBps,
    chainId: BASE_CHAIN_ID,
    dryRun: opts.dryRun,
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
      amountIn: formatEthHuman(amountInRawWei),
      amountInRawWei,
      tokensOut,
      tokensOutRaw,
      tokenDecimals,
      entryMcap: null,
      feeWei: swap.feeWei,
      slippageBpsUsed: slippageBps,
      protectedExec: false,
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
      realizedEth: 0,
      unrealizedEth: 0,
      unrealizedPct: 0,
      lastPricedAt: null,
    },
  }

  writePosition(position)

  return {
    positionPath: positionPath('base', opts.ca),
    txHash: swap.txHash,
    amountIn: position.entry.amountIn,
    amountInRawWei,
    tokensOut,
    tokensOutRaw,
    tokenDecimals,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
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
}

export interface SellBaseResult {
  positionPath: string
  txHash: string
  tokensIn: string
  tokensInRaw: string
  ethOut: string
  ethOutRawWei: string
  realizedEth: number
  positionStatus: 'open' | 'closed'
  wallet: string
  mint: string
  dryRun: boolean
  feeWei: string
  slippageBpsUsed: number
  approvalTxHash?: string
}

export async function sellBase(opts: SellBaseOpts): Promise<SellBaseResult> {
  assertValidEvmAddress(opts.ca)
  if (!opts.reason?.trim()) throw new Error('Missing --reason')
  if (!(opts.percent > 0 && opts.percent <= 100)) {
    throw new Error(`--percent must be in (0, 100], got ${opts.percent}`)
  }

  const position = readPosition('base', opts.ca)
  if (!position) throw new Error(`No Base position found for ${opts.ca}`)
  if (position.status !== 'open') throw new Error(`Position ${opts.ca} is already closed`)

  const cfg = loadTradingConfig()
  const slippageBps = opts.slippageBps ?? cfg.defaultSlippageBps ?? 100

  const {
    executeEvmSwap,
    ensureErc20Approval,
    makeEvmProvider,
    NATIVE_ETH,
    BASE_CHAIN_ID,
    DEFAULT_BASE_RPC,
  } = await import('./evm-trading.js')

  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)
  if (signer.address.toLowerCase() !== position.wallet.toLowerCase()) {
    throw new Error(
      `Wallet mismatch: position was opened from ${position.wallet} but signer is ${signer.address}.`,
    )
  }

  const provider = makeEvmProvider(opts.rpcUrl ?? DEFAULT_BASE_RPC)
  const connectedWallet = signer.wallet.connect(provider) as import('ethers').Wallet

  // BigInt math: remaining = totalEntry - sumOfSells (in u256 raw)
  const totalRaw = BigInt(position.entry.tokensOutRaw)
  const soldRaw = position.sells.reduce((acc, s) => acc + BigInt(s.tokensInRaw), 0n)
  const remainingRaw = totalRaw - soldRaw
  if (remainingRaw <= 0n) throw new Error('No tokens remaining to sell.')

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
    destToken: NATIVE_ETH,
    srcAmount: tokensToSellRaw.toString(),
    srcDecimals: position.entry.tokenDecimals,
    destDecimals: 18,
    slippageBps,
    chainId: BASE_CHAIN_ID,
    dryRun: opts.dryRun,
    onTxBuilt: async (txBlob) => {
      if (opts.dryRun) return // skip approval in dry-run
      const result = await ensureErc20Approval(
        connectedWallet,
        opts.ca,
        txBlob.to,
        tokensToSellRaw,
      )
      if (result.approved && result.txHash) approvalTxHash = result.txHash
    },
  })

  const ethOutRawWei = swap.destAmount
  const ethOutDisplay = formatEthHuman(ethOutRawWei)
  const tokensInUi = Number(BigInt(tokensToSellRaw.toString())) / Math.pow(10, position.entry.tokenDecimals)
  const tokensInDisplay = formatTokensHuman(tokensInUi, 6)

  // Realized PnL: proportional cost basis vs net proceeds.
  // costWei = (entryAmountInWei + entryFeeWei) * tokensSold / totalTokens
  const entryAmountWei = BigInt(position.entry.amountInRawWei)
  const entryFeeWei = BigInt(position.entry.feeWei ?? '0')
  const totalEntryCostWei = entryAmountWei + entryFeeWei
  const costWei = (totalEntryCostWei * tokensToSellRaw) / totalRaw
  const sellFeeWei = BigInt(swap.feeWei)
  const proceedsNetWei = BigInt(ethOutRawWei) - sellFeeWei
  const realizedWei = proceedsNetWei - costWei
  // realizedEth as JS number — for typical positions (<1 ETH), fits comfortably.
  const realizedEth = Number(realizedWei) / 1e18

  const nowIso = new Date().toISOString()
  position.sells.push({
    tx: swap.txHash,
    time: nowIso,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    ethOut: ethOutDisplay,
    ethOutRawWei,
    percentRequested: opts.percent,
    realizedEth,
    reason: opts.reason.trim(),
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
    protectedExec: false,
  })

  position.pnl.realizedEth = position.sells.reduce((a, s) => a + s.realizedEth, 0)

  const newSoldRaw = soldRaw + tokensToSellRaw
  if (newSoldRaw >= totalRaw) {
    position.status = 'closed'
    position.pnl.unrealizedEth = 0
    position.pnl.unrealizedPct = 0
  }

  writePosition(position)

  return {
    positionPath: positionPath('base', opts.ca),
    txHash: swap.txHash,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    ethOut: ethOutDisplay,
    ethOutRawWei,
    realizedEth,
    positionStatus: position.status,
    wallet: signer.address,
    mint: opts.ca,
    dryRun: !!opts.dryRun,
    feeWei: swap.feeWei,
    slippageBpsUsed: slippageBps,
    approvalTxHash,
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
    BASE_CHAIN_ID,
    DEFAULT_BASE_RPC,
  } = await import('./evm-trading.js')

  const signer = await resolveEvmSigner(opts.walletRef, opts.passphrase)
  const provider = makeEvmProvider(opts.rpcUrl ?? DEFAULT_BASE_RPC)

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
        const route = await fetchParaswapPrice({
          srcToken: p.mint,
          destToken: NATIVE_ETH,
          amount: bookRaw.toString(),
          srcDecimals: p.entry.tokenDecimals,
          destDecimals: 18,
          network: BASE_CHAIN_ID,
        })
        const quotedEthOutWei = BigInt(route.destAmount)
        // Proportional cost basis in wei.
        const entryCostWei = BigInt(p.entry.amountInRawWei) + BigInt(p.entry.feeWei ?? '0')
        const remainingCostWei = (entryCostWei * bookRaw) / totalRaw
        const diffWei = quotedEthOutWei - remainingCostWei
        unrealizedEth = Number(diffWei) / 1e18
        unrealizedPct = remainingCostWei > 0n
          ? (Number(diffWei) / Number(remainingCostWei)) * 100
          : 0
        p.pnl.unrealizedEth = unrealizedEth
        p.pnl.unrealizedPct = unrealizedPct
        p.pnl.lastPricedAt = nowIso
      } catch (e: any) {
        priceNote = `quote failed: ${e?.message ?? String(e)}`
      }
    } else {
      p.pnl.unrealizedEth = 0
      p.pnl.unrealizedPct = 0
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
      amountIn: formatSolHuman(amountInRawSol, 4),
      amountInRawSol: amountInRawSol,
      tokensOut,
      tokensOutRaw,
      tokenDecimals,
      entryMcap,
      feeLamports,
      tipLamports,
      slippageBpsUsed: slippageBps,
      protectedExec: !!opts.protectedExec,
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
    protectedExec: !!opts.protectedExec,
    feeLamports,
    tipLamports,
    forensics,
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
    feeLamports,
    tipLamports,
    slippageBpsUsed: slippageBps,
    slippageSource,
    protectedExec: !!opts.protectedExec,
    forensics,
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
  solOut: string
  solOutRaw: number
  realizedSol: number
  positionStatus: 'open' | 'closed'
  wallet: string
  mint: string
  dryRun: boolean
  // Phase 2
  feeLamports: number
  tipLamports: number
  slippageBpsUsed: number
  slippageSource: 'user' | 'dexscreener' | 'fallback'
  protectedExec: boolean
  forensics?: FillForensics
}

export async function sell(opts: SellOpts): Promise<SellResult> {
  const mintPk = assertValidMint(opts.ca)
  if (!opts.reason?.trim()) throw new Error('Missing --reason')
  if (!(opts.percent > 0 && opts.percent <= 100)) {
    throw new Error(`--percent must be in (0, 100], got ${opts.percent}`)
  }

  const position = readPosition('solana', opts.ca)
  if (!position) throw new Error(`No position found for ${opts.ca}`)
  if (position.status !== 'open') throw new Error(`Position ${opts.ca} is already closed`)

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

  const signer = await resolveSigner(opts.walletRef, opts.passphrase)
  if (signer.address !== position.wallet) {
    throw new Error(
      `Wallet mismatch: position was opened from ${position.wallet} but signer is ${signer.address}.`,
    )
  }
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

  const swap = await executeSwap({
    connection,
    wallet: signer.keypair,
    inputMint: mintPk.toBase58(),
    outputMint: SOL_MINT.toBase58(),
    inputAmountRaw: Number(tokensToSellRaw),
    slippageBps,
    dryRun: opts.dryRun,
    quoteMaxAgeMs,
    jitoTipLamports,
  })

  const solOutRaw = swap.outputAmountRaw          // gross SOL out (fee + tip already added back)
  const feeLamports = swap.feeLamports ?? 0
  const tipLamports = swap.tipLamports ?? 0
  const tokensInUi = Number(tokensToSellRaw) / Math.pow(10, position.entry.tokenDecimals)
  const tokensInDisplay = formatTokensHuman(tokensInUi, 6)
  const solOutDisplay = formatSolHuman(solOutRaw, 6)

  // FIFO realized PnL, fee-aware on both sides.
  //   entryCost includes entry fee + tip — Phase 2 positions store these; Phase 1
  //   positions had only amountInRawSol (fee/tip default to 0 via ??).
  //   sellNetProceeds = grossSolOut - sellFee - sellTip.
  const entryFee = position.entry.feeLamports ?? 0
  const entryTip = position.entry.tipLamports ?? 0
  const entryCostLamports = position.entry.amountInRawSol + entryFee + entryTip
  const entryCostSol = entryCostLamports / 1e9
  const proportion = Number(tokensToSellRaw) / Number(totalRaw)
  const costSol = proportion * entryCostSol
  const netProceedsSol = (solOutRaw - feeLamports - tipLamports) / 1e9
  const realizedSol = netProceedsSol - costSol

  const forensics: FillForensics | undefined = opts.dryRun
    ? undefined
    : analyzeFill(swap.quotedOutRaw, swap.outputAmountRaw, slippageBps)

  const nowIso = new Date().toISOString()
  position.sells.push({
    tx: swap.txSignature,
    time: nowIso,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    solOut: solOutDisplay,
    solOutRaw,
    percentRequested: opts.percent,
    realizedSol,
    reason: opts.reason.trim(),
    feeLamports,
    tipLamports,
    slippageBpsUsed: slippageBps,
    protectedExec: !!opts.protectedExec,
    forensics,
  })

  position.pnl.realizedSol = position.sells.reduce((a, s) => a + s.realizedSol, 0)

  const newSoldRaw = soldRaw + tokensToSellRaw
  if (newSoldRaw >= totalRaw) {
    position.status = 'closed'
    position.pnl.unrealizedSol = 0
    position.pnl.unrealizedPct = 0
  }

  writePosition(position)

  appendTradeLog({
    kind: 'sell',
    ts: nowIso,
    chain: 'solana',
    wallet: signer.address,
    mint: opts.ca,
    tx: swap.txSignature,
    tokensIn: tokensInDisplay,
    solOut: netProceedsSol,
    percentRequested: opts.percent,
    realizedSol,
    reason: opts.reason.trim(),
    protectedExec: !!opts.protectedExec,
    feeLamports,
    tipLamports,
    forensics,
  })

  return {
    positionPath: positionPath('solana', opts.ca),
    txSignature: swap.txSignature,
    tokensIn: tokensInDisplay,
    tokensInRaw: tokensToSellRaw.toString(),
    solOut: solOutDisplay,
    solOutRaw,
    realizedSol,
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
        const q = await fetchQuote({
          inputMint: p.mint,
          outputMint: SOL_MINT.toBase58(),
          amount: Number(bookRaw),
          slippageBps: slippageBpsForQuote,
        })
        const solOut = Number(q.outAmount) / 1e9
        const entrySol = p.entry.amountInRawSol / 1e9
        const proportion = Number(bookRaw) / Number(totalRaw)
        const remCost = proportion * entrySol
        unrealizedSol = solOut - remCost
        unrealizedPct = remCost > 0 ? (unrealizedSol / remCost) * 100 : 0
        p.pnl.unrealizedSol = unrealizedSol
        p.pnl.unrealizedPct = unrealizedPct
        p.pnl.lastPricedAt = nowIso
      } catch (e: any) {
        priceNote = `quote failed: ${e.message}`
      }
    } else {
      p.pnl.unrealizedSol = 0
      p.pnl.unrealizedPct = 0
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

// ───────── pnl ─────────

export interface PnlOpts {
  by?: 'wallet' | 'chain'
  sinceIso?: string
  includeClosed?: boolean
}

export interface PnlReport {
  totalRealizedSol: number
  totalUnrealizedSol: number
  totalSol: number
  count: number
  byGroup?: Record<string, { realizedSol: number; unrealizedSol: number; count: number }>
}

export function computePnl(opts: PnlOpts = {}): PnlReport {
  const positions = listPositions({ includeClosed: opts.includeClosed ?? true })
  // Phase 5b: cross-chain aggregation in native units is meaningless (1 SOL ≠ 1 ETH).
  // For now `pnl` aggregates only Solana positions; Base positions get their own
  // view in `positions` and `position <CA>`. Cross-chain USD-converted totals are
  // a Phase 5c concern.
  const solanaPositions = (
    opts.sinceIso
      ? positions.filter((p) => p.entry.time >= opts.sinceIso!)
      : positions
  ).filter((p): p is SolanaPositionFile => p.chain === 'solana')

  let totalRealizedSol = 0
  let totalUnrealizedSol = 0
  const byGroup: Record<string, { realizedSol: number; unrealizedSol: number; count: number }> = {}

  for (const p of solanaPositions) {
    totalRealizedSol += p.pnl.realizedSol
    totalUnrealizedSol += p.pnl.unrealizedSol
    if (opts.by) {
      const key = opts.by === 'wallet' ? p.wallet : p.chain
      if (!byGroup[key]) byGroup[key] = { realizedSol: 0, unrealizedSol: 0, count: 0 }
      byGroup[key].realizedSol += p.pnl.realizedSol
      byGroup[key].unrealizedSol += p.pnl.unrealizedSol
      byGroup[key].count += 1
    }
  }

  return {
    totalRealizedSol,
    totalUnrealizedSol,
    totalSol: totalRealizedSol + totalUnrealizedSol,
    count: solanaPositions.length,
    byGroup: opts.by ? byGroup : undefined,
  }
}
