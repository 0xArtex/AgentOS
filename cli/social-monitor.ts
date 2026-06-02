/**
 * Monitor-job — the unattended half of the self-learning loop. Periodically
 * runs `tiktok analytics <acct>` (which scrapes + categorizes + snapshots) for
 * the monitored accounts, so `tiktok review` always has fresh data + a trend.
 *
 * Mirrors the wallet daemon: one-shot `tick`, detached `start` (re-invokes the
 * CLI in `_run` mode), `stop`, `status`. State lives under ~/.palmyr/social/monitor.
 * Each tick reuses the tested analytics command (shelled out) so auth + the SDK
 * path are identical — the daemon only owns the schedule + account list + state.
 */
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function socialDir(): string { return process.env.PALMYR_SOCIAL_PATH || join(homedir(), '.palmyr', 'social') }
function monDir(): string { return join(socialDir(), 'monitor') }
function pidFile(): string { return join(monDir(), 'daemon.pid') }
function statusFile(): string { return join(monDir(), 'daemon.status.json') }
function logFile(): string { return join(monDir(), 'daemon.log') }
function ensureDirs(): void { const d = monDir(); if (!existsSync(d)) mkdirSync(d, { recursive: true }) }

export interface MonitorOpts { intervalSeconds: number; accounts: string[] } // accounts: explicit list (resolved by the caller)
export interface TickResult { account: string; ok: boolean; error?: string }

/**
 * One tick: run `tiktok analytics <acct>` for each account via our own CLI.
 * Reuses the full tested path (auth, scrape, categorize, snapshot). Returns a
 * per-account ok/error report.
 */
export function monitorTick(cliPath: string, accounts: string[]): TickResult[] {
  const results: TickResult[] = []
  for (const account of accounts) {
    const r = spawnSync(process.argv[0], [cliPath, 'tiktok', 'analytics', account, '--json'], { encoding: 'utf8', timeout: 180000, env: process.env })
    const ok = r.status === 0
    results.push({ account, ok, error: ok ? undefined : String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200) })
  }
  return results
}

export function isMonitorRunning(): { pid: number | null; running: boolean } {
  if (!existsSync(pidFile())) return { pid: null, running: false }
  const pid = Number(readFileSync(pidFile(), 'utf8').trim())
  if (!pid || !Number.isFinite(pid)) return { pid: null, running: false }
  try { process.kill(pid, 0); return { pid, running: true } } catch { return { pid, running: false } }
}

export function monitorStatus(): { pid: number | null; running: boolean; lastTick: string | null; opts: MonitorOpts | null; lastResults?: TickResult[] } {
  const { pid, running } = isMonitorRunning()
  let lastTick: string | null = null, opts: MonitorOpts | null = null, lastResults: TickResult[] | undefined
  if (existsSync(statusFile())) {
    try { const d = JSON.parse(readFileSync(statusFile(), 'utf8')); lastTick = d.lastTick ?? null; opts = d.opts ?? null; lastResults = d.lastResults } catch {}
  }
  return { pid, running, lastTick, opts, lastResults }
}

export function startMonitor(cliPath: string, opts: MonitorOpts): { pid: number } {
  const st = isMonitorRunning()
  if (st.running) throw new Error(`Monitor already running (PID ${st.pid}). Run \`palmyr tiktok monitor stop\` first.`)
  if (existsSync(pidFile())) { try { unlinkSync(pidFile()) } catch {} }
  ensureDirs()
  const args = [cliPath, 'tiktok', 'monitor', '_run', '--interval', String(opts.intervalSeconds)]
  if (opts.accounts.length) args.push('--account', opts.accounts.join(','))
  const child = spawn(process.argv[0], args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  if (!child.pid) throw new Error('Failed to spawn monitor child process.')
  child.unref()
  writeFileSync(pidFile(), String(child.pid))
  writeFileSync(statusFile(), JSON.stringify({ lastTick: null, opts, pid: child.pid }, null, 2))
  return { pid: child.pid }
}

export async function stopMonitor(): Promise<{ wasRunning: boolean; pid: number | null }> {
  const st = isMonitorRunning()
  if (!st.running) { if (existsSync(pidFile())) { try { unlinkSync(pidFile()) } catch {} } return { wasRunning: false, pid: st.pid ?? null } }
  try { process.kill(st.pid!, 'SIGTERM') } catch {}
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 100)); if (!isMonitorRunning().running) break }
  if (existsSync(pidFile())) { try { unlinkSync(pidFile()) } catch {} }
  return { wasRunning: true, pid: st.pid }
}

/** The detached loop (invoked via `tiktok monitor _run`). NOT user-facing. */
export async function runMonitorLoop(cliPath: string, opts: MonitorOpts): Promise<void> {
  ensureDirs()
  let exit = false
  const onExit = () => { exit = true }
  process.on('SIGTERM', onExit); process.on('SIGINT', onExit)
  writeFileSync(pidFile(), String(process.pid))
  while (!exit) {
    const start = Date.now()
    try {
      const lastResults = monitorTick(cliPath, opts.accounts)
      writeFileSync(statusFile(), JSON.stringify({ lastTick: new Date().toISOString(), opts, pid: process.pid, lastResults }, null, 2))
    } catch (e: any) {
      appendFileSync(logFile(), `[${new Date().toISOString()}] ERROR: ${e?.message ?? String(e)}\n`)
    }
    const sleepEnd = start + opts.intervalSeconds * 1000
    while (Date.now() < sleepEnd && !exit) await new Promise(r => setTimeout(r, 200))
  }
}

/** Parse "6h" / "30m" / "45s" / bare-seconds → seconds. */
export function parseInterval(s: string | undefined, fallback = 21600): number {
  if (!s) return fallback
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/i)
  if (!m) return fallback
  const v = parseFloat(m[1]); const u = (m[2] || 's').toLowerCase()
  return Math.round(v * (u === 'd' ? 86400 : u === 'h' ? 3600 : u === 'm' ? 60 : 1))
}
