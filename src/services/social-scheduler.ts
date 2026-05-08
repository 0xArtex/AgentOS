/**
 * Server-side worker that fires due scheduled posts from
 * `scheduled_social_posts`. Lives inside the AgentOS Node process; one
 * instance per process. Polls every SOCIAL_SCHEDULER_INTERVAL_SEC seconds
 * (default 30), claims due items atomically, dispatches via the existing
 * internal `postTweet`/etc. functions, then writes the result back.
 *
 * Payments are NOT charged here — the schedule API already collected x402
 * payment at create time. The worker just executes pre-paid work.
 *
 * Cookie freshness handled by `getResolvedSession` (re-logs in via stored
 * credentials when cached cookies are >12h old).
 */
import {
  getDueScheduled,
  claimScheduled,
  markScheduledCompleted,
  markScheduledFailed,
  type ScheduledPostSummary,
} from "./scheduled-posts";
import { getResolvedSession, SessionResolveError } from "./registered-accounts";
import {
  postTweet,
  postTweetThread,
  type OpResult,
} from "./social-operations";

const RETRYABLE_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "UI_TIMEOUT",
  "LAUNCH_FAILED",
  "UNKNOWN",
]);

interface DispatchOutcome {
  ok: boolean;
  result?: any;
  error?: string;
  retryable: boolean;
}

async function dispatchOne(item: ScheduledPostSummary): Promise<DispatchOutcome> {
  // Resolve to a ready-to-use session — re-logs in if cookies are stale.
  // Note: we don't have wallet here (it's not in ScheduledPostSummary), so
  // we look it up via the schedule row's wallet. Cleaner: pass wallet through
  // from getDueScheduled. For now, query the row separately.
  const { db } = await import("../db");
  const row = db.prepare(`SELECT wallet FROM scheduled_social_posts WHERE id=?`).get(item.id) as { wallet: string } | undefined;
  if (!row) {
    return { ok: false, retryable: false, error: "Schedule row vanished mid-claim" };
  }

  let session;
  try {
    session = await getResolvedSession(row.wallet, item.registered_account_id);
  } catch (e: any) {
    if (e instanceof SessionResolveError) {
      // Session resolution failure (account revoked, login broken, etc.) is
      // terminal — re-trying won't help until the user re-registers.
      return { ok: false, retryable: false, error: `Session resolve failed: ${e.message} [${e.code}]` };
    }
    return { ok: false, retryable: true, error: `Session resolve crashed: ${e.message}` };
  }

  const opReq = {
    account_id: session.account_id,
    proxy_session_id: session.proxy_session_id,
    cookies: session.cookies,
  };

  let result: OpResult<any>;
  try {
    if (item.action === "post") {
      result = await postTweet({
        ...opReq,
        text: item.payload.text || "",
        community_id: item.payload.community_id,
      });
    } else if (item.action === "post_thread") {
      result = await postTweetThread({
        ...opReq,
        texts: item.payload.texts || [],
        community_id: item.payload.community_id,
      });
    } else if (item.action === "post_media") {
      result = await postTweet({
        ...opReq,
        text: item.payload.text || "",
        media: item.payload.media as any[],
        community_id: item.payload.community_id,
      });
    } else {
      return { ok: false, retryable: false, error: `Unknown action: ${(item as any).action}` };
    }
  } catch (e: any) {
    // Crash inside the dispatch function itself — likely transient (browser
    // launch failed, network blip). Treat as retryable.
    return { ok: false, retryable: true, error: `Dispatch crashed: ${e.message || String(e)}` };
  }

  if (!result.success) {
    const code = result.error_code || "UNKNOWN";
    return {
      ok: false,
      retryable: RETRYABLE_ERROR_CODES.has(code),
      error: `${result.error || "unknown"} [${code}]`,
    };
  }

  return { ok: true, result: result.data || {}, retryable: false };
}

let workerStarted = false;
let workerInterval: NodeJS.Timeout | null = null;

export interface TickReport {
  startedAt: string;
  due: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; error?: string; retryable?: boolean }>;
}

/**
 * Run a single tick: scan for due items, claim and dispatch each one,
 * record results. Exported so tests / `--once`-style invocations can call it.
 */
export async function runSocialSchedulerTick(): Promise<TickReport> {
  const startedAt = new Date().toISOString();
  const due = getDueScheduled();
  const results: TickReport["results"] = [];

  for (const item of due) {
    if (!claimScheduled(item.id)) continue;          // raced with another worker, or cancelled

    const outcome = await dispatchOne(item);
    if (outcome.ok) {
      markScheduledCompleted(item.id, outcome.result);
    } else {
      markScheduledFailed(item.id, outcome.error || "unknown", outcome.retryable);
    }
    results.push({
      id: item.id,
      ok: outcome.ok,
      error: outcome.error,
      retryable: outcome.retryable,
    });
  }

  return {
    startedAt,
    due: results.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  };
}

/**
 * Start the long-running scheduler. Called once from `src/index.ts` after
 * `app.listen`. Returns immediately; ticks run in the background. Subsequent
 * calls are no-ops (single-process worker by design).
 *
 * Disable entirely by setting SOCIAL_SCHEDULER_DISABLED=1 (useful for tests
 * or for running a separate dedicated worker process later).
 */
export function startSocialScheduler(): void {
  if (workerStarted) return;
  if (process.env.SOCIAL_SCHEDULER_DISABLED === "1") {
    console.log("[social-scheduler] disabled via SOCIAL_SCHEDULER_DISABLED=1");
    return;
  }

  const intervalSec = Math.max(
    10,
    parseInt(process.env.SOCIAL_SCHEDULER_INTERVAL_SEC || "30", 10) || 30
  );

  workerStarted = true;

  // Fire once at startup so ticks aren't delayed by a full interval.
  runTickQuietly().catch(() => {});

  workerInterval = setInterval(runTickQuietly, intervalSec * 1000);
  workerInterval.unref();                             // don't hold the process open

  console.log(`[social-scheduler] started (poll every ${intervalSec}s)`);
}

/**
 * Stop the scheduler. Returns immediately; in-flight ticks complete on their
 * own. Mostly used by tests; production servers run until shutdown anyway.
 */
export function stopSocialScheduler(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  workerStarted = false;
}

async function runTickQuietly(): Promise<void> {
  try {
    const report = await runSocialSchedulerTick();
    if (report.due > 0) {
      const summary = `[social-scheduler] tick: ${report.succeeded}/${report.due} ok` +
        (report.failed > 0 ? `, ${report.failed} failed` : "");
      console.log(summary);
      for (const r of report.results) {
        if (!r.ok) {
          console.log(`  - ${r.id}: ${r.error}${r.retryable ? " (will retry)" : ""}`);
        }
      }
    }
  } catch (e: any) {
    // Ticks should never throw — runSocialSchedulerTick catches per-item errors.
    // If we get here, something at the framework level broke; log and keep the loop alive.
    console.error("[social-scheduler] tick crashed:", e?.message || e);
  }
}
