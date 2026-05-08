/**
 * Worker that consumes due scheduled items from cli/social-queue.ts and
 * dispatches them via the existing paid X routes through the SDK.
 *
 * Designed to run inside the same Node process as the CLI — `agentos worker`
 * keeps polling until SIGINT/SIGTERM. There's also a `--once` mode for cron.
 *
 * Failure classification routes back into the queue: retryable codes (rate
 * limit, transient browser issue) get re-scheduled with exponential backoff;
 * non-retryable codes (bad input, missing session) move to `failed[]`.
 */
import type { AgentOS } from './sdk.js'
import * as sq from './social-queue.js'
import * as sv from './social-vault.js'

export interface DispatchResult {
  ok: boolean
  result?: any
  error?: string
  retryable: boolean
}

/**
 * Codes returned by social-operations.ts. Retryable ones get re-scheduled
 * by the queue; the rest move to `failed[]` immediately.
 */
const RETRYABLE_CODES = new Set([
  'RATE_LIMITED',
  'UI_TIMEOUT',
  'LAUNCH_FAILED',
  'UNKNOWN',
])

export async function dispatchScheduledItem(
  item: sq.ScheduledItem,
  ao: AgentOS
): Promise<DispatchResult> {
  // Resolve account + session from local vault. Session staleness is the
  // worker's most common failure — surface it clearly so the user knows to
  // re-login (and so it doesn't waste retry attempts).
  const acc = sv.getAccount('twitter', item.account_username)
  if (!acc) {
    return {
      ok: false,
      retryable: false,
      error: `Account "${item.account_username}" not found in local vault.`,
    }
  }
  const sess = sv.loadSession(acc.id)
  if (!sess || !sess.cookies || sess.cookies.length === 0) {
    return {
      ok: false,
      retryable: false,
      error: `No cached session for "${item.account_username}". Run: agentos twitter login ${item.account_username}`,
    }
  }
  const psid = sv.getProxySessionId('twitter', item.account_username)

  // Materialise media to wire format only at dispatch time (keeps the queue
  // file small; scheduled items reference paths or URLs).
  let mediaForWire: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }> | undefined
  if (item.media && item.media.length > 0) {
    try {
      mediaForWire = item.media.map(m => sq.materializeMediaRefForWire(m))
    } catch (e: any) {
      return { ok: false, retryable: false, error: `Media materialise failed: ${e.message}` }
    }
  }

  // Dispatch by action shape.
  let data: any
  try {
    if (item.action === 'post') {
      data = await ao.socialTwitterPost(acc.id, sess.cookies, item.text || '', psid, item.community_id)
    } else if (item.action === 'post_thread') {
      data = await ao.socialTwitterPostThread(acc.id, sess.cookies, item.texts || [], psid, item.community_id)
    } else if (item.action === 'post_media') {
      data = await ao.socialTwitterPostWithMedia(
        acc.id,
        sess.cookies,
        item.text || '',
        mediaForWire || [],
        psid,
        item.community_id,
      )
    } else {
      return { ok: false, retryable: false, error: `Unknown action: ${(item as any).action}` }
    }
  } catch (e: any) {
    // Network/HTTP errors thrown from the SDK are retryable by default.
    return { ok: false, retryable: true, error: e.message || String(e) }
  }

  if (!data?.success) {
    const code = data?.error_code || 'UNKNOWN'
    return {
      ok: false,
      retryable: RETRYABLE_CODES.has(code),
      error: `${data?.error || 'unknown error'} [${code}]`,
    }
  }

  // Update last_action_at on the account so the local vault's freshness
  // tracking stays accurate even when posting via the worker.
  sv.updateMeta('twitter', item.account_username, { last_action_at: new Date().toISOString() })

  return { ok: true, retryable: false, result: data.data || {} }
}

export interface TickSummary {
  tickStartedAt: string
  processed: number
  succeeded: number
  failed: number
  results: Array<{
    id: string
    account: string
    action: string
    ok: boolean
    error?: string
    retryable?: boolean
    result?: any
  }>
}

export async function runWorkerOnce(
  ao: AgentOS,
  accountFilter?: string
): Promise<TickSummary> {
  const tickStartedAt = new Date().toISOString()
  const due = sq.getDueScheduled().filter(i => !accountFilter || i.account_username === accountFilter)
  const results: TickSummary['results'] = []

  for (const item of due) {
    // markScheduledInProgress is the lock — if another worker already claimed
    // this item, it returns false and we skip.
    if (!sq.markScheduledInProgress(item.id)) continue

    const r = await dispatchScheduledItem(item, ao)
    if (r.ok) {
      sq.markScheduledPublished(item.id, r.result)
    } else {
      sq.markScheduledFailed(item.id, r.error || 'unknown', r.retryable)
    }
    results.push({
      id: item.id,
      account: item.account_username,
      action: item.action,
      ok: r.ok,
      error: r.error,
      retryable: r.retryable,
      result: r.result,
    })
  }

  return {
    tickStartedAt,
    processed: results.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  }
}

export interface WorkerLoopOptions {
  intervalSec: number
  accountFilter?: string
  onLog: (msg: string) => void
  onTick?: (summary: TickSummary) => void
}

export async function runWorkerLoop(
  ao: AgentOS,
  opts: WorkerLoopOptions
): Promise<void> {
  let stopped = false
  const stop = (sig: string) => {
    if (!stopped) {
      stopped = true
      opts.onLog(`${sig} received, stopping after current tick`)
    }
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  opts.onLog(
    `Worker started (interval ${opts.intervalSec}s` +
    (opts.accountFilter ? `, account ${opts.accountFilter}` : '') +
    `)`,
  )

  while (!stopped) {
    let summary: TickSummary
    try {
      summary = await runWorkerOnce(ao, opts.accountFilter)
    } catch (e: any) {
      // A throw here is unusual (runWorkerOnce catches per-item errors).
      // Log and keep the loop alive so a single bad tick doesn't kill the worker.
      opts.onLog(`Tick crashed: ${e.message}`)
      await sleep(opts.intervalSec * 1000)
      continue
    }
    opts.onTick?.(summary)
    if (summary.processed > 0) {
      opts.onLog(
        `Tick: ${summary.succeeded}/${summary.processed} ok` +
        (summary.failed > 0 ? `, ${summary.failed} failed` : ''),
      )
      for (const r of summary.results) {
        opts.onLog(
          `  - ${r.id} [${r.account}/${r.action}]: ${r.ok ? 'OK' : 'FAIL'} ` +
          (r.ok ? JSON.stringify(r.result) : `${r.error}${r.retryable ? ' (will retry)' : ''}`),
        )
      }
    }
    if (stopped) break
    await sleep(opts.intervalSec * 1000)
  }

  opts.onLog('Worker stopped')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
