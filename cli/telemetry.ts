/**
 * Opt-in CLI telemetry. Off by default. Silent — no banners, no agent-mode noise.
 *
 * What's captured (only when explicitly enabled):
 *   - installId  (random UUID, generated on opt-in, stored locally)
 *   - cmd        (e.g. "phone search", "wallet create" — no flag values)
 *   - exitCode
 *   - durationMs
 *   - cliVersion, nodeVersion, platform
 *
 * What's NEVER captured: flag values, positional args, stdout/stderr, secrets,
 * wallet addresses, phone numbers — anything user-supplied.
 *
 * Architecture: each command's exit handler synchronously appends one JSONL line
 * to ~/.palmyr/telemetry-queue.jsonl. The next CLI invocation reads the queue,
 * fires a single POST to /telemetry, and deletes the queue on 2xx. Network
 * failures keep the events queued for next time.
 *
 * Why not POST live? process.on('exit') can only run sync code; async work is
 * dropped. The queue-and-flush-next-run pattern guarantees nothing gets lost
 * to a crash or a `process.exit()` from deep in a handler.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

const HOME = join(homedir(), '.palmyr')
const STATE_PATH = join(HOME, 'telemetry.json')
const QUEUE_PATH = join(HOME, 'telemetry-queue.jsonl')

// Cap the queue so a long offline streak doesn't grow unbounded.
const MAX_QUEUE_BYTES = 256 * 1024

export interface TelemetryState {
  enabled: boolean
  installId?: string
  optedInAt?: string
}

export function getState(): TelemetryState {
  if (!existsSync(STATE_PATH)) return { enabled: false }
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) }
  catch { return { enabled: false } }
}

export function setEnabled(enabled: boolean): TelemetryState {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true })
  const cur = getState()
  const next: TelemetryState = {
    enabled,
    installId: cur.installId || (enabled ? randomUUID() : undefined),
    optedInAt: enabled ? (cur.optedInAt || new Date().toISOString()) : undefined,
  }
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2))
  // Drop pending events on opt-out so we never ship data the user just revoked.
  if (!enabled) {
    try { if (existsSync(QUEUE_PATH)) unlinkSync(QUEUE_PATH) } catch {}
  }
  return next
}

export function queuedCount(): number {
  if (!existsSync(QUEUE_PATH)) return 0
  try {
    const raw = readFileSync(QUEUE_PATH, 'utf8')
    return raw.split('\n').filter(l => l.trim()).length
  } catch { return 0 }
}

export interface EventInput {
  cmd: string
  exitCode: number
  durationMs: number
  cliVersion: string
  nodeVersion: string
  platform: string
}

interface QueuedEvent extends EventInput {
  installId: string
  ts: string
}

/**
 * Synchronous append. Safe to call from process.on('exit') — async work in
 * that handler is silently dropped by Node, so this MUST stay sync.
 */
export function appendEventSync(ev: EventInput): void {
  const state = getState()
  if (!state.enabled || !state.installId) return
  try {
    if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true })
    // Trim oldest if queue ran past cap (offline streak protection).
    if (existsSync(QUEUE_PATH) && statSync(QUEUE_PATH).size > MAX_QUEUE_BYTES) {
      const lines = readFileSync(QUEUE_PATH, 'utf8').split('\n').filter(l => l.trim())
      writeFileSync(QUEUE_PATH, lines.slice(-200).join('\n') + '\n')
    }
    const full: QueuedEvent = { ...ev, installId: state.installId, ts: new Date().toISOString() }
    appendFileSync(QUEUE_PATH, JSON.stringify(full) + '\n')
  } catch {}
}

/**
 * Fire-and-forget flush. Call once at CLI start, then proceed with the
 * user's command — the fetch runs in parallel with their actual work.
 * Aborts after 3s so a dead API never hangs the CLI.
 */
export async function flushQueue(apiBase: string): Promise<void> {
  const state = getState()
  if (!state.enabled) return
  if (!existsSync(QUEUE_PATH)) return
  let raw: string
  try { raw = readFileSync(QUEUE_PATH, 'utf8') } catch { return }

  const events: QueuedEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { events.push(JSON.parse(trimmed)) } catch {}
  }
  if (events.length === 0) {
    try { unlinkSync(QUEUE_PATH) } catch {}
    return
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.ok) {
      try { unlinkSync(QUEUE_PATH) } catch {}
    }
  } catch {
    // Stay queued for next run.
  }
}
