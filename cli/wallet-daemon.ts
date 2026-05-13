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
  sync,
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

function ensureDaemonDirs() {
  for (const d of [DAEMON_DIR, TRIGGERS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

// ───────── Trigger types ─────────

export interface TriggerFire {
  ts: string
  chain: 'solana'
  wallet: string
  mint: string
  trigger: 'cut' | 'takeProfit'
  thresholdPct: number
  currentPct: number
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

/** Parse "-25%", "+40%", "25", "-25.5%" → number. Returns null on malformed input. */
export function parsePctString(s: string | undefined | null): number | null {
  if (!s) return null
  const m = s.trim().match(/^([+-]?\d+(?:\.\d+)?)%?$/)
  return m ? Number(m[1]) : null
}

/**
 * Decide which triggers (if any) fire for a position right now.
 * - `cut`: fire when `unrealizedPct ≤ thresholdPct` (typically negative)
 * - `takeProfit`: fire when `unrealizedPct ≥ thresholdPct` (typically positive)
 * Phase 3 lite: both fire on a *full* exit (sell-100). Partial-fire semantics
 * land in Phase 3.5 alongside the trailing-stop trigger.
 */
export function evaluateTriggers(p: PositionFile): TriggerFire[] {
  if (p.status !== 'open') return []
  const out: TriggerFire[] = []
  const ts = new Date().toISOString()
  const currentPct = p.pnl.unrealizedPct

  const cutThreshold = parsePctString(p.exitPlan.cut)
  if (cutThreshold !== null && currentPct <= cutThreshold) {
    out.push({
      ts,
      chain: 'solana',
      wallet: p.wallet,
      mint: p.mint,
      trigger: 'cut',
      thresholdPct: cutThreshold,
      currentPct,
      proposedAction: 'sell-100',
      autoExecuted: false,
    })
  }

  const tpThreshold = parsePctString(p.exitPlan.takeProfit)
  if (tpThreshold !== null && currentPct >= tpThreshold) {
    out.push({
      ts,
      chain: 'solana',
      wallet: p.wallet,
      mint: p.mint,
      trigger: 'takeProfit',
      thresholdPct: tpThreshold,
      currentPct,
      proposedAction: 'sell-100',
      autoExecuted: false,
    })
  }

  return out
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
  fires: TriggerFire[]
}

/**
 * One daemon iteration: sync (refreshes unrealized PnL) → evaluate triggers →
 * persist fires → optionally auto-execute. Returns the fires that fired this
 * tick, so the caller (CLI tick or daemon loop) can render them.
 */
export async function daemonTick(opts: DaemonOpts): Promise<TickReport> {
  // 1. Sync the wallet's open positions. This refreshes pnl.unrealizedPct
  //    from chain + Jupiter quote, and writes updated position files atomically.
  const syncReport = await sync({ walletRef: opts.walletRef })

  // 2. Re-read positions (they were just written by sync) and evaluate triggers.
  //    We use the syncReport's mint list rather than re-scanning the dir.
  const fires: TriggerFire[] = []
  for (const syncEntry of syncReport.positions) {
    const p = readPosition('solana', syncEntry.mint)
    if (!p) continue
    const positionFires = evaluateTriggers(p)
    for (const fire of positionFires) {
      // Auto-execute first (so the fire record carries the resulting sell tx)
      if (opts.autoExecute) {
        try {
          const sellResult = await sell({
            ca: fire.mint,
            percent: 100,
            reason: `auto: ${fire.trigger} fired at ${fire.currentPct.toFixed(2)}% (threshold ${fire.thresholdPct}%)`,
            walletRef: opts.walletRef,
          })
          fire.autoExecuted = true
          fire.linkedSellTx = sellResult.txSignature
        } catch (e: any) {
          fire.error = e?.message ?? String(e)
        }
      }
      appendPendingTrigger(fire)
      const logLine: TradeLogLine = {
        kind: 'monitor_fire',
        ts: fire.ts,
        chain: 'solana',
        wallet: fire.wallet,
        mint: fire.mint,
        trigger: fire.trigger,
        thresholdPct: fire.thresholdPct,
        currentPct: fire.currentPct,
        proposedAction: fire.proposedAction,
        autoExecuted: fire.autoExecuted,
        linkedSellTx: fire.linkedSellTx,
        note: fire.error,
      }
      appendTradeLog(logLine)
      fires.push(fire)
    }
  }

  return { syncedPositions: syncReport.positions.length, fires }
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

export async function startDaemon(opts: DaemonOpts): Promise<{ pid: number }> {
  const status = isDaemonRunning()
  if (status.running) {
    throw new Error(`Daemon already running (PID ${status.pid}). Run \`palmyr wallet daemon stop\` first.`)
  }
  // Clean up a stale PID file from a previous crash
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
  ensureDaemonDirs()

  // argv[0] = node, argv[1] = dist/cli.js. Re-invoke ourselves in _run mode.
  const args = [
    process.argv[1],
    'wallet', 'daemon', '_run',
    '--interval', String(opts.intervalSeconds),
  ]
  if (opts.autoExecute) args.push('--auto')
  if (opts.walletRef) args.push('--wallet', opts.walletRef)

  const child = spawn(process.argv[0], args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  if (!child.pid) throw new Error('Failed to spawn daemon child process.')
  child.unref()

  writeFileSync(PID_FILE, String(child.pid))
  writeFileSync(
    STATUS_FILE,
    JSON.stringify({ lastTick: null, opts, pid: child.pid }, null, 2),
  )
  return { pid: child.pid }
}

export async function stopDaemon(): Promise<{ wasRunning: boolean; pid: number | null }> {
  const status = isDaemonRunning()
  if (!status.running) {
    if (existsSync(PID_FILE)) {
      try { unlinkSync(PID_FILE) } catch {}
    }
    return { wasRunning: false, pid: status.pid ?? null }
  }
  try {
    process.kill(status.pid!, 'SIGTERM')
  } catch {}
  // Give the daemon up to ~2s to clean up gracefully.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const re = isDaemonRunning()
    if (!re.running) break
  }
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
  return { wasRunning: true, pid: status.pid }
}

/**
 * The actual long-running loop the detached daemon executes. Invoked when the
 * child process is started via `palmyr wallet daemon _run`. NOT user-facing.
 */
export async function runDaemonLoop(opts: DaemonOpts): Promise<void> {
  ensureDaemonDirs()

  let shouldExit = false
  const handleExit = () => { shouldExit = true }
  process.on('SIGTERM', handleExit)
  process.on('SIGINT', handleExit)

  // Always write our PID on startup (in case the parent didn't manage to before
  // we got here, or to overwrite a stale one).
  writeFileSync(PID_FILE, String(process.pid))

  while (!shouldExit) {
    const tickStart = Date.now()
    try {
      const report = await daemonTick(opts)
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          lastTick: new Date().toISOString(),
          opts,
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

    // Sleep with early-exit checks every 100ms so SIGTERM gets handled promptly.
    const sleepEnd = tickStart + opts.intervalSeconds * 1000
    while (Date.now() < sleepEnd && !shouldExit) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  // Graceful shutdown
  if (existsSync(PID_FILE)) {
    try { unlinkSync(PID_FILE) } catch {}
  }
}
