/**
 * Auto-monitor daemon — Phase 3.
 *
 * One-shot mode: `palmyr wallet daemon tick` runs the loop body once and
 * exits (useful for cron-driven monitoring or ad-hoc checks).
 *
 * Long-running mode: `palmyr wallet daemon start` spawns a detached child
 * process that runs the loop until `stop` is called (SIGTERM). Lives at:
 *   ~/.palmyr/trading/daemon/daemon.pid     — PID of running daemon
 *   ~/.palmyr/trading/daemon/daemon.status  — JSON: lastTick, opts
 *   ~/.palmyr/trading/daemon/daemon.log     — append-only error log
 *
 * Each tick: syncs all open positions for the configured wallet, then
 * evaluates `exitPlan.cut` / `exitPlan.takeProfit` against the refreshed
 * `pnl.unrealizedPct`. Fires get appended to:
 *   ~/.palmyr/trading/triggers/pending.jsonl
 *
 * If `--auto` is set, the daemon also calls `sell(percent=100)` for each
 * fired trigger and links the resulting tx back to the fire record.
 */

import { spawn } from 'child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import {
  TRADING_DIR,
  appendTradeLog,
  listPositions,
  readPosition,
  sell,
  sellBase,
  sync,
  syncBase,
  writePosition,
  type PositionFile,
  type TradeLogLine,
} from './wallet-trading.js'

// ───────── Paths ─────────

const DAEMON_DIR = join(TRADING_DIR, 'daemon')
const TRIGGERS_DIR = join(TRADING_DIR, 'triggers')
const PID_FILE = join(DAEMON_DIR, 'daemon.pid')
const STATUS_FILE = join(DAEMON_DIR, 'daemon.status.json')
const LOG_FILE = join(DAEMON_DIR, 'daemon.log')
const PENDING_FILE = join(TRIGGERS_DIR, 'pending.jsonl')
/**
 * Bug 3 — cooperative shutdown flag. `process.kill(pid, 'SIGTERM')` hard-kills
 * on Windows (handlers never run), which can terminate the daemon mid-tick —
 * e.g. between a confirmed on-chain sell and the `writePosition` that records
 * it. Instead, `stopDaemon` writes this file and the loop checks for it at safe
 * points (between ticks, never mid-sell) and exits cleanly. Cross-platform.
 */
const STOP_FILE = join(DAEMON_DIR, 'daemon.stop')

/**
 * Bug 5 — floor for the tick interval. `Number(flags.interval)` can yield
 * NaN/0/negative, which made `sleepEnd = tickStart + NaN*1000` and spun the
 * loop with no delay, hammering RPCs. We clamp to this minimum.
 */
const MIN_INTERVAL_SECONDS = 5
const DEFAULT_INTERVAL_SECONDS = 30

/**
 * Coerce an interval to a safe positive number of seconds. Rejects NaN, ≤0, and
 * non-finite input (falling back to the default), then enforces a hard floor so
 * the daemon can never busy-loop.
 */
export function normalizeIntervalSeconds(seconds: number): number {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_SECONDS
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(n))
}

function ensureDaemonDirs() {
  for (const d of [DAEMON_DIR, TRIGGERS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

// ───────── Trigger types ─────────

export interface TriggerFire {
  ts: string
  chain: 'solana' | 'base'
  wallet: string
  mint: string
  trigger: 'cut' | 'takeProfit' | 'trailingStop' | 'timeLimit' | 'thesis_falsified'
  currentPct: number
  /** cut / takeProfit / trailingStop: the threshold value in pct points. */
  thresholdPct?: number
  /** trailingStop: peak unrealizedPct that the position has reached. */
  peakPct?: number
  /** trailingStop: drawdown from peak (peakPct − currentPct). Precomputed so agents don't have to. */
  drawdownPct?: number
  /** timeLimit: configured duration in milliseconds. */
  thresholdDurationMs?: number
  /** timeLimit: actual elapsed milliseconds since entry at fire time. */
  elapsedMs?: number
  /** thesis_falsified: LLM verdict from the most recent check. */
  llmVerdict?: 'yes' | 'no' | 'unclear'
  /** thesis_falsified: short LLM reasoning string. */
  llmReasoning?: string
  proposedAction: 'sell-100'
  autoExecuted: boolean
  linkedSellTx?: string
  error?: string
}

export interface DaemonOpts {
  intervalSeconds: number
  autoExecute: boolean
  walletRef?: string
}

export interface DaemonStatus {
  pid: number | null
  running: boolean
  lastTick: string | null
  opts: DaemonOpts | null
}

// ───────── Trigger parsing + evaluation ─────────

/**
 * Build a human-readable reason string for an auto-executed sell. Picks
 * trigger-appropriate detail rather than always rendering `thresholdPct%` —
 * a `timeLimit` trigger has no PnL threshold, so the old format produced
 * `threshold undefined%`. Falls back gracefully for any unknown trigger kind.
 */
export function formatTriggerReason(fire: TriggerFire): string {
  const pct = `${fire.currentPct.toFixed(2)}%`
  switch (fire.trigger) {
    case 'timeLimit': {
      const elapsedM = fire.elapsedMs !== undefined ? Math.round(fire.elapsedMs / 60_000) : null
      const thresholdM = fire.thresholdDurationMs !== undefined ? Math.round(fire.thresholdDurationMs / 60_000) : null
      if (elapsedM !== null && thresholdM !== null) {
        return `auto: timeLimit fired after ${elapsedM}m > ${thresholdM}m; selling 100%`
      }
      return `auto: timeLimit fired; selling 100%`
    }
    case 'trailingStop': {
      const allowedDrop = fire.thresholdPct !== undefined ? `${fire.thresholdPct.toFixed(2)}%` : '?%'
      if (fire.peakPct !== undefined) {
        const drawdown = (fire.drawdownPct ?? fire.peakPct - fire.currentPct).toFixed(2)
        const peakSigned = `${fire.peakPct >= 0 ? '+' : ''}${fire.peakPct.toFixed(2)}%`
        return `auto: trailingStop fired: drop ${drawdown}% from peak ${peakSigned} > ${allowedDrop} allowed; selling 100%`
      }
      return `auto: trailingStop fired at ${pct}; drop allowed ${allowedDrop}; selling 100%`
    }
    case 'thesis_falsified': {
      const verdict = fire.llmVerdict ?? 'no'
      return `auto: thesis_falsified (LLM verdict=${verdict}); selling 100%`
    }
    case 'cut':
    case 'takeProfit': {
      const threshold = fire.thresholdPct !== undefined ? `${fire.thresholdPct.toFixed(2)}%` : '?%'
      return `auto: ${fire.trigger} fired at ${pct} (threshold ${threshold}); selling 100%`
    }
    default:
      return `auto: ${fire.trigger} fired at ${pct}; selling 100%`
  }
}

/** Parse "-25%", "+40%", "25", "-25.5%" → number. Returns null on malformed input. */
export function parsePctString(s: string | undefined | null): number | null {
  if (!s) return null
  const m = s.trim().match(/^([+-]?\d+(?:\.\d+)?)%?$/)
  return m ? Number(m[1]) : null
}

/**
 * Parse a duration string like "24h", "30m", "7d", "45s", or a bare number
 * (seconds) into milliseconds. Returns null on malformed input.
 */
export function parseDurationToMs(s: string | undefined | null): number | null {
  if (!s) return null
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] || 's').toLowerCase()
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * mult[unit]
}

/**
 * Decide which triggers (if any) fire for a position right now. All triggers
 * propose a full exit (`sell-100`).
 *
 * - `cut`: fire when `unrealizedPct ≤ thresholdPct` (typically negative)
 * - `takeProfit`: fire when `unrealizedPct ≥ thresholdPct` (typically positive)
 * - `trailingStop`: fire when `peakUnrealizedPct - currentPct ≥ trailPct` AND
 *   peak > 0. The peak-gated condition keeps trailing distinct from cut: it
 *   only arms after the position has been in profit, otherwise a positive
 *   trail value would be equivalent to a stop loss at `-trailPct`.
 * - `timeLimit`: fire when `Date.now() - new Date(entry.time).getTime() ≥
 *   thresholdDurationMs`. Time-only — fires regardless of PnL.
 */
export function evaluateTriggers(p: PositionFile): TriggerFire[] {
  if (p.status !== 'open') return []
  const out: TriggerFire[] = []
  const ts = new Date().toISOString()
  const currentPct = p.pnl.unrealizedPct
  const base = {
    ts,
    chain: p.chain,
    wallet: p.wallet,
    mint: p.mint,
    currentPct,
    proposedAction: 'sell-100' as const,
    autoExecuted: false,
  }

  // Without auto-execute the position stays 'open', so a threshold that's met
  // keeps re-firing every tick — spamming pending.jsonl + the trade log. Gate
  // each trigger on a fire-once watermark (mirrors lastThesisFiredAt below).
  const fired = p.monitorState?.firedTriggers ?? {}

  const cutThreshold = parsePctString(p.exitPlan.cut)
  if (cutThreshold !== null && currentPct <= cutThreshold && !fired.cut) {
    out.push({ ...base, trigger: 'cut', thresholdPct: cutThreshold })
  }

  const tpThreshold = parsePctString(p.exitPlan.takeProfit)
  if (tpThreshold !== null && currentPct >= tpThreshold && !fired.takeProfit) {
    out.push({ ...base, trigger: 'takeProfit', thresholdPct: tpThreshold })
  }

  const trailPct = parsePctString(p.exitPlan.trailingStop)
  if (
    trailPct !== null &&
    p.monitorState &&
    p.monitorState.peakUnrealizedPct > 0 &&
    p.monitorState.peakUnrealizedPct - currentPct >= trailPct &&
    !fired.trailingStop
  ) {
    const peak = p.monitorState.peakUnrealizedPct
    out.push({
      ...base,
      trigger: 'trailingStop',
      thresholdPct: trailPct,
      peakPct: peak,
      drawdownPct: peak - currentPct,
    })
  }

  const limitMs = parseDurationToMs(p.exitPlan.timeLimit)
  if (limitMs !== null) {
    const elapsedMs = Date.now() - new Date(p.entry.time).getTime()
    if (elapsedMs >= limitMs && !fired.timeLimit) {
      out.push({
        ...base,
        trigger: 'timeLimit',
        thresholdDurationMs: limitMs,
        elapsedMs,
      })
    }
  }

  // Phase 7: thesis_falsified — fires when the most recent LLM check returned
  // 'no'. Gated on `lastThesisCheckAt > lastThesisFiredAt` so we only fire once
  // per check; the daemon stamps `lastThesisFiredAt` after appending the fire.
  if (p.exitPlan.thesisCheck && p.monitorState?.lastThesisVerdict === 'no') {
    const checkedAt = p.monitorState.lastThesisCheckAt
    const firedAt = p.monitorState.lastThesisFiredAt
    const isNewVerdict = !!checkedAt && (!firedAt || checkedAt > firedAt)
    if (isNewVerdict) {
      out.push({
        ...base,
        trigger: 'thesis_falsified',
        llmVerdict: 'no',
        llmReasoning: p.monitorState.lastThesisReasoning,
      })
    }
  }

  return out
}

/**
 * Update the per-position peak watermark used by the trailing-stop trigger.
 * Called after sync (which refreshed `pnl.unrealizedPct`), before
 * evaluateTriggers. Initializes monitorState if missing.
 */
export function updateMonitorPeak(p: PositionFile): PositionFile {
  const currentPct = p.pnl.unrealizedPct
  const nowIso = new Date().toISOString()
  if (!p.monitorState) {
    p.monitorState = { peakUnrealizedPct: currentPct, peakAt: nowIso }
  } else if (currentPct > p.monitorState.peakUnrealizedPct) {
    p.monitorState.peakUnrealizedPct = currentPct
    p.monitorState.peakAt = nowIso
  }
  return p
}

/**
 * Phase 7 — if `exitPlan.thesisCheck` is set and enough time has passed since
 * the last LLM check, call `evaluateBriefWithLLM` and stash the verdict in
 * `monitorState`. Non-fatal on error (logs to daemon.log, returns unchanged).
 */
async function maybeRunThesisCheck(p: PositionFile): Promise<void> {
  const interval = parseDurationToMs(p.exitPlan.thesisCheck)
  if (interval === null) return

  const last = p.monitorState?.lastThesisCheckAt
  if (last) {
    const elapsed = Date.now() - new Date(last).getTime()
    if (elapsed < interval) return
  }

  try {
    const { evaluateBriefWithLLM } = await import('./wallet-brief-llm.js')
    const llm = await evaluateBriefWithLLM(p)
    if (!p.monitorState) {
      p.monitorState = { peakUnrealizedPct: p.pnl.unrealizedPct, peakAt: new Date().toISOString() }
    }
    p.monitorState.lastThesisCheckAt = new Date().toISOString()
    p.monitorState.lastThesisVerdict = llm.thesisHolds
    p.monitorState.lastThesisReasoning = llm.reasoning
  } catch (e: any) {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] thesis check failed for ${p.mint}: ${e?.message ?? String(e)}\n`,
    )
  }
}

// ───────── Pending triggers persistence ─────────

export function appendPendingTrigger(fire: TriggerFire) {
  ensureDaemonDirs()
  appendFileSync(PENDING_FILE, JSON.stringify(fire) + '\n')
}

export interface ListPendingFilter {
  ca?: string
  sinceIso?: string
}

export function listPendingTriggers(filter: ListPendingFilter = {}): TriggerFire[] {
  if (!existsSync(PENDING_FILE)) return []
  const lines = readFileSync(PENDING_FILE, 'utf8').split('\n').filter(Boolean)
  const out: TriggerFire[] = []
  for (const line of lines) {
    try {
      const f = JSON.parse(line) as TriggerFire
      if (filter.ca && f.mint !== filter.ca) continue
      if (filter.sinceIso && f.ts < filter.sinceIso) continue
      out.push(f)
    } catch {}
  }
  return out
}

export function clearPendingTriggers() {
  if (existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE)
}

// ───────── Daemon tick ─────────

export interface TickReport {
  syncedPositions: number
  syncedSolana: number
  syncedBase: number
  fires: TriggerFire[]
  /**
   * Non-fatal sync errors per chain. The daemon doesn't abort on a single
   * chain failing — it logs to daemon.log and reports here.
   */
  errors: { chain: 'solana' | 'base'; message: string }[]
}

/**
 * One daemon iteration: sync (refreshes unrealized PnL) → evaluate triggers →
 * persist fires → optionally auto-execute. Returns the fires that fired this
 * tick, so the caller (CLI tick or daemon loop) can render them.
 *
 * Phase 5d — also syncs Base positions when the walletRef can resolve to an
 * EVM signer (i.e. `trading:N`). Solana sync runs first and is "default
 * critical": if Solana fails the whole tick errors. Base sync is best-effort
 * and adds an error to the report but doesn't abort the tick.
 */
export async function daemonTick(opts: DaemonOpts): Promise<TickReport> {
  // Bug 6 — the one-shot `daemon tick` path doesn't go through runDaemonLoop, so
  // on a fresh install the daemon dirs may not exist yet. Several error paths
  // below `appendFileSync(LOG_FILE, ...)`; without the dir that throws ENOENT and
  // masks the real failure. Cheap + idempotent, so do it unconditionally here.
  ensureDaemonDirs()

  const fires: TriggerFire[] = []
  const errors: TickReport['errors'] = []

  // 1. Solana sync — same path as Phase 3.
  const solanaSync = await sync({ walletRef: opts.walletRef })
  for (const syncEntry of solanaSync.positions) {
    // Phase 4c — read scoped to the synced wallet so cohort positions
    // (multiple wallets holding the same mint) don't collide.
    const p = readPosition('solana', syncEntry.mint, solanaSync.wallet)
    if (!p) continue
    updateMonitorPeak(p)
    await maybeRunThesisCheck(p)
    writePosition(p)
    fires.push(...await processPositionFires(p, opts))
  }

  // 2. Base sync — best-effort. Any wallet ref with EVM derivation works:
  //    vault wallets (default — BIP39 mnemonic with both Solana + EVM paths)
  //    or `trading:N` keystore refs. Skipped only when no walletRef is set
  //    (env-keypair fallback has no EVM derivation). Failures are non-fatal.
  let syncedBase = 0
  if (opts.walletRef) {
    try {
      const baseSync = await syncBase({ walletRef: opts.walletRef })
      syncedBase = baseSync.positions.length
      for (const syncEntry of baseSync.positions) {
        const p = readPosition('base', syncEntry.mint, baseSync.wallet)
        if (!p) continue
        updateMonitorPeak(p)
        await maybeRunThesisCheck(p)
        writePosition(p)
        fires.push(...await processPositionFires(p, opts))
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      errors.push({ chain: 'base', message: msg })
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] base sync failed: ${msg}\n`)
    }
  }

  return {
    syncedPositions: solanaSync.positions.length + syncedBase,
    syncedSolana: solanaSync.positions.length,
    syncedBase,
    fires,
    errors,
  }
}

/**
 * Bug-7 guard: detect a threshold whose sign is almost certainly inverted, so
 * `--auto` doesn't market-sell a healthy position on its very first tick. A
 * `cut` (stop-loss) is meant to be negative ("get me out at -25%"), so a
 * non-negative `cut` fires immediately at 0% PnL. A `takeProfit` is meant to be
 * positive, so a non-positive `takeProfit` fires immediately too. `trailingStop`
 * is a drawdown magnitude and `timeLimit`/`thesis_falsified` carry no PnL sign,
 * so they're never flagged here.
 */
function isLikelyInvertedThreshold(fire: TriggerFire): boolean {
  if (fire.thresholdPct === undefined) return false
  if (fire.trigger === 'cut') return fire.thresholdPct >= 0
  if (fire.trigger === 'takeProfit') return fire.thresholdPct <= 0
  return false
}

/**
 * Re-read the position fresh from disk and stamp the fire-once watermark for
 * this trigger, then write the FRESH copy back. Never writes a pre-sell
 * snapshot: when auto-execute ran a successful sell, `sell()`/`sellBase()` have
 * already re-read → appended the sell → set `status:'closed'` → written the
 * file, so stamping must happen on top of that fresh state (otherwise the
 * executed sell + realized PnL are clobbered and the position reverts to
 * "open"). If the file is gone (e.g. archived on a same-tick re-entry) we do
 * nothing rather than resurrect a stale copy.
 */
function stampFiredWatermark(
  chain: 'solana' | 'base',
  mint: string,
  wallet: string,
  fire: TriggerFire,
): void {
  const fresh = readPosition(chain, mint, wallet)
  if (!fresh) return
  if (!fresh.monitorState) {
    fresh.monitorState = { peakUnrealizedPct: fresh.pnl.unrealizedPct, peakAt: fire.ts }
  }
  if (fire.trigger === 'thesis_falsified') {
    fresh.monitorState.lastThesisFiredAt = fire.ts
  } else if (
    fire.trigger === 'cut' || fire.trigger === 'takeProfit' ||
    fire.trigger === 'trailingStop' || fire.trigger === 'timeLimit'
  ) {
    if (!fresh.monitorState.firedTriggers) fresh.monitorState.firedTriggers = {}
    fresh.monitorState.firedTriggers[fire.trigger] = fire.ts
  }
  writePosition(fresh)
}

/**
 * Phase 5d — extracted per-position fire processing so we can run it for
 * both Solana and Base positions without duplicating the logic. Chain-dispatch
 * happens inside (sell vs sellBase, sync chain stamp on log line).
 */
async function processPositionFires(p: PositionFile, opts: DaemonOpts): Promise<TriggerFire[]> {
  const positionFires = evaluateTriggers(p)
  const out: TriggerFire[] = []
  for (const fire of positionFires) {
    // Bug 7 — refuse to auto-execute an obviously-inverted threshold (e.g.
    // `--cut 25%` with a forgotten minus fires at 0% PnL). We still surface the
    // fire (pending + trade log) so it's visible, but we do NOT sell and we do
    // NOT arm the watermark, so correcting the exit plan re-enables monitoring.
    const invertedUnderAuto = opts.autoExecute && isLikelyInvertedThreshold(fire)
    if (invertedUnderAuto) {
      fire.error =
        `refused: ${fire.trigger} threshold ${fire.thresholdPct}% looks inverted ` +
        `(fires at ${fire.currentPct.toFixed(2)}% PnL). Did you mean ` +
        `${fire.trigger === 'cut' ? '-' : '+'}${Math.abs(fire.thresholdPct ?? 0)}%? Not auto-selling.`
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] ${fire.chain} ${fire.mint}: ${fire.error}\n`,
      )
    }

    // Track whether a sell actually hit the chain this tick. Only a genuinely
    // executed sell arms the fire-once watermark; a failed sell (RPC hiccup,
    // 429, blockhash expiry) leaves the trigger un-armed so it retries next
    // tick instead of silently disarming a stop-loss (bug 2).
    let sellExecuted = false
    let sellWallet = p.wallet
    if (opts.autoExecute && !invertedUnderAuto) {
      try {
        const sellReason = formatTriggerReason(fire)
        if (p.chain === 'solana') {
          const sellResult = await sell({
            ca: fire.mint,
            percent: 100,
            reason: sellReason,
            walletRef: opts.walletRef,
          })
          fire.autoExecuted = true
          fire.linkedSellTx = sellResult.txSignature
          sellWallet = sellResult.wallet
          sellExecuted = true
        } else {
          const sellResult = await sellBase({
            ca: fire.mint,
            percent: 100,
            reason: sellReason,
            walletRef: opts.walletRef,
          })
          fire.autoExecuted = true
          fire.linkedSellTx = sellResult.txHash
          sellWallet = sellResult.wallet
          sellExecuted = true
        }
      } catch (e: any) {
        fire.error = e?.message ?? String(e)
      }
    }
    appendPendingTrigger(fire)
    const logLine: TradeLogLine = {
      kind: 'monitor_fire',
      ts: fire.ts,
      chain: fire.chain,
      wallet: fire.wallet,
      mint: fire.mint,
      trigger: fire.trigger,
      currentPct: fire.currentPct,
      thresholdPct: fire.thresholdPct,
      peakPct: fire.peakPct,
      drawdownPct: fire.drawdownPct,
      thresholdDurationMs: fire.thresholdDurationMs,
      elapsedMs: fire.elapsedMs,
      llmVerdict: fire.llmVerdict,
      llmReasoning: fire.llmReasoning,
      proposedAction: fire.proposedAction,
      autoExecuted: fire.autoExecuted,
      linkedSellTx: fire.linkedSellTx,
      note: fire.error,
    }
    appendTradeLog(logLine)

    // Arm the fire-once watermark only when it's safe to stop re-firing:
    //   - auto-execute OFF: the position stays open, so we MUST stamp or the
    //     trigger re-appends to pending.jsonl every tick.
    //   - auto-execute ON + sell EXECUTED: the exit happened; stamp so a
    //     partial/closed position never re-sells (idempotent — for a closed
    //     position this is cosmetic, but it future-proofs partial exits).
    //   - auto-execute ON + sell FAILED (or refused as inverted): do NOT stamp,
    //     so the trigger re-evaluates next tick and retries the safety exit.
    // Bug 1 — stamp on a FRESH re-read of the position, never the pre-sell
    // in-memory snapshot, so a successful sell isn't reverted to "open".
    const shouldStamp = !opts.autoExecute || sellExecuted
    if (shouldStamp) {
      stampFiredWatermark(p.chain, fire.mint, sellWallet, fire)
    }
    out.push(fire)
  }
  return out
}

// ───────── Process-level daemon management ─────────

export function isDaemonRunning(): { pid: number | null; running: boolean } {
  if (!existsSync(PID_FILE)) return { pid: null, running: false }
  const raw = readFileSync(PID_FILE, 'utf8').trim()
  const pid = Number(raw)
  if (!pid || !Number.isFinite(pid)) return { pid: null, running: false }
  try {
    // Signal 0 doesn't deliver a signal; it just checks the process exists.
    process.kill(pid, 0)
    return { pid, running: true }
  } catch {
    return { pid, running: false }
  }
}

export function getDaemonStatus(): DaemonStatus {
  const { pid, running } = isDaemonRunning()
  let lastTick: string | null = null
  let opts: DaemonOpts | null = null
  if (existsSync(STATUS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as {
        lastTick?: string
        opts?: DaemonOpts
      }
      lastTick = data.lastTick ?? null
      opts = data.opts ?? null
    } catch {}
  }
  return { pid, running, lastTick, opts }
}

/**
 * Atomically claim the PID lock for `pid`. Uses an exclusive-create write
 * (`flag: 'wx'`, O_EXCL) so two concurrent `startDaemon` callers can't both
 * win — the second create throws EEXIST. If the existing file is owned by a
 * DEAD process (stale lock from a crash), it's removed and the claim retried
 * once. Returns true on success; false if a LIVE daemon already holds the lock.
 */
function tryAcquirePidLock(pid: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(PID_FILE, String(pid), { flag: 'wx' })
      return true
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      // Someone holds the lock. Only reclaim it if that process is dead.
      const holder = isDaemonRunning()
      if (holder.running) return false
      try { unlinkSync(PID_FILE) } catch {}
      // loop and retry the exclusive create exactly once
    }
  }
  return false
}

export async function startDaemon(opts: DaemonOpts): Promise<{ pid: number }> {
  ensureDaemonDirs()
  const intervalSeconds = normalizeIntervalSeconds(opts.intervalSeconds)
  const normalizedOpts: DaemonOpts = { ...opts, intervalSeconds }

  // Bug 4 — atomic check-and-claim. We seed the lock with our OWN pid via an
  // exclusive create so two racing `daemon start`s can't both spawn (the loser
  // gets a live-holder rejection here). A stale lock from a dead pid is cleaned
  // up inside tryAcquirePidLock.
  if (!tryAcquirePidLock(process.pid)) {
    const status = isDaemonRunning()
    throw new Error(`Daemon already running (PID ${status.pid}). Run \`palmyr wallet daemon stop\` first.`)
  }

  // A leftover stop-flag from a previous run would make the fresh daemon exit on
  // its first loop check — clear it now that we hold the lock.
  if (existsSync(STOP_FILE)) {
    try { unlinkSync(STOP_FILE) } catch {}
  }

  // argv[0] = node, argv[1] = dist/cli.js. Re-invoke ourselves in _run mode.
  const args = [
    process.argv[1],
    'wallet', 'daemon', '_run',
    '--interval', String(intervalSeconds),
  ]
  if (normalizedOpts.autoExecute) args.push('--auto')
  if (normalizedOpts.walletRef) args.push('--wallet', normalizedOpts.walletRef)

  let child
  try {
    child = spawn(process.argv[0], args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (e) {
    // Don't strand the lock if spawn throws synchronously.
    try { unlinkSync(PID_FILE) } catch {}
    throw e
  }
  if (!child.pid) {
    try { unlinkSync(PID_FILE) } catch {}
    throw new Error('Failed to spawn daemon child process.')
  }
  child.unref()

  // Hand the lock over from our placeholder pid to the actual child pid. The
  // child also writes its own pid on startup (runDaemonLoop), so this is belt-
  // and-suspenders — but it makes `status` correct immediately.
  writeFileSync(PID_FILE, String(child.pid))
  writeFileSync(
    STATUS_FILE,
    JSON.stringify({ lastTick: null, opts: normalizedOpts, pid: child.pid }, null, 2),
  )
  return { pid: child.pid }
}

export async function stopDaemon(): Promise<{ wasRunning: boolean; pid: number | null }> {
  const status = isDaemonRunning()
  if (!status.running) {
    // Clean up any leftover lock/flag from a crashed run.
    if (existsSync(PID_FILE)) {
      try { unlinkSync(PID_FILE) } catch {}
    }
    if (existsSync(STOP_FILE)) {
      try { unlinkSync(STOP_FILE) } catch {}
    }
    return { wasRunning: false, pid: status.pid ?? null }
  }

  // Bug 3 — cooperative shutdown. Write the stop flag and let the loop notice it
  // at a safe point (between ticks, never mid-sell). This works on Windows,
  // where SIGTERM would hard-kill and could interrupt a sell→writePosition.
  ensureDaemonDirs()
  try { writeFileSync(STOP_FILE, new Date().toISOString()) } catch {}

  // Wait for the daemon to exit on its own. It removes its PID file on a clean
  // exit, so we poll liveness. Bound the wait generously: a tick may be mid-sync
  // (network) when the flag lands, and we only exit between ticks. ~30s budget.
  let exited = false
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (!isDaemonRunning().running) { exited = true; break }
  }

  // Bounded fallback: if the daemon is wedged (e.g. stuck in a hung RPC call and
  // never reached a flag check), escalate to a signal so `stop` still works.
  if (!exited) {
    try { process.kill(status.pid!, 'SIGTERM') } catch {}
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (!isDaemonRunning().running) { exited = true; break }
    }
  }

  // Clean up the lock + flag regardless (the daemon usually clears the PID file
  // itself on clean exit; this covers the signal-fallback path too).
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
  if (existsSync(STOP_FILE)) {
    try { unlinkSync(STOP_FILE) } catch {}
  }
  return { wasRunning: true, pid: status.pid }
}

/**
 * The actual long-running loop the detached daemon executes. Invoked when the
 * child process is started via `palmyr wallet daemon _run`. NOT user-facing.
 */
export async function runDaemonLoop(opts: DaemonOpts): Promise<void> {
  ensureDaemonDirs()

  // Bug 5 — clamp the interval where it's actually consumed, so a NaN/0/negative
  // value (e.g. `--interval abc`) can't spin the loop with no delay.
  const intervalSeconds = normalizeIntervalSeconds(opts.intervalSeconds)
  const runOpts: DaemonOpts = { ...opts, intervalSeconds }

  let shouldExit = false
  const handleExit = () => { shouldExit = true }
  // Secondary shutdown paths: Ctrl-C (SIGINT) when run in a foreground shell,
  // and the SIGTERM fallback from stopDaemon if the cooperative flag is missed.
  // On Windows these may not run before a hard kill, which is exactly why the
  // STOP_FILE flag (checked below) is the primary mechanism.
  process.on('SIGTERM', handleExit)
  process.on('SIGINT', handleExit)

  // Bug 3 — a stop is requested either via the cooperative flag file (primary,
  // works on Windows) or via a signal that set `shouldExit`.
  const stopRequested = () => shouldExit || existsSync(STOP_FILE)

  // Always write our PID on startup (in case the parent didn't manage to before
  // we got here, or to overwrite a stale one).
  writeFileSync(PID_FILE, String(process.pid))

  // Check once up front: if a stop flag is somehow already present, exit before
  // running any tick.
  while (!stopRequested()) {
    const tickStart = Date.now()
    try {
      const report = await daemonTick(runOpts)
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          lastTick: new Date().toISOString(),
          opts: runOpts,
          pid: process.pid,
          lastTickFiredCount: report.fires.length,
        }, null, 2),
      )
    } catch (e: any) {
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] ERROR: ${e?.message ?? String(e)}\n`,
      )
    }

    // Sleep with early-exit checks every 100ms so a stop request (flag or
    // signal) is handled promptly — but only ever BETWEEN ticks, never mid-sell.
    const sleepEnd = tickStart + intervalSeconds * 1000
    while (Date.now() < sleepEnd && !stopRequested()) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  // Graceful shutdown — release the lock and clear the cooperative stop flag so
  // the next `daemon start` isn't tricked into exiting immediately.
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
  if (existsSync(STOP_FILE)) {
    try { unlinkSync(STOP_FILE) } catch {}
  }
}
