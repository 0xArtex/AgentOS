/**
 * Async runner for the "simple" TikTok browser ops: follow, like, delete,
 * profile (bio/display name), avatar.
 *
 * Like posting, each of these drives a headless browser and can run long enough
 * to brush Cloudflare's ~100s tunnel timeout (a delete measured at ~60s in
 * prod), which would 524 the caller after payment settled. So they run as async
 * operations sharing the same envelope as posts: the route returns 202
 * { operation_id, poll_url } immediately and a background worker does the work,
 * auto-refunding on failure.
 *
 * These ops are simpler than posting in one important way: they are all
 * SAFE TO RETRY (idempotent or near-idempotent — re-following someone you
 * already follow is a no-op, re-liking is a no-op, re-deleting a gone video is a
 * no-op, re-setting a bio/avatar to the same value is a no-op). So unlike the
 * post worker, there is NO reconciliation oracle: any failure (including an
 * ambiguous one where the click may have landed) just fails + refunds, and the
 * caller can safely retry. Worst case on an ambiguous success is a $0.001
 * over-refund — never a double-post-style harm.
 *
 * Lifecycle: pending → running → (done | failed). The video bytes / image bytes
 * / cookies live in the worker closure (the `run` thunk), never persisted — so a
 * crash before/while running just refunds (safe; the caller retries).
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { refundUsdcToPayer, RefundOpts, RefundResult } from "./refund";
import type { TikTokOpResult } from "./tiktok-operations";
import { rotateProxyExit } from "./social-runtime";
import { noteSuccess, noteFailure } from "./tiktok-accounts";

export type TikTokOpName = "follow" | "like" | "delete" | "profile" | "avatar";
export type TikTokOpJobStatus = "pending" | "running" | "done" | "failed";

export interface TikTokOpJobRow {
  id: string;
  op: TikTokOpName;
  account_id: string;
  owner: string;
  payment_signature: string | null;
  payment_chain: "solana" | "base" | null;
  charged_usdc: number | null;
  status: TikTokOpJobStatus;
  result_json: string | null;
  error: string | null;
  error_code: string | null;
  refund_id: string | null;
  refund_status: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_op_jobs (
    id TEXT PRIMARY KEY,
    op TEXT NOT NULL CHECK(op IN ('follow','like','delete','profile','avatar')),
    account_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    payment_signature TEXT,
    payment_chain TEXT,
    charged_usdc REAL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed')),
    result_json TEXT,
    error TEXT,
    error_code TEXT,
    refund_id TEXT,
    refund_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tiktok_op_owner ON tiktok_op_jobs(owner);
  CREATE INDEX IF NOT EXISTS idx_tiktok_op_status ON tiktok_op_jobs(status);
`);

export interface TikTokOpDeps {
  refund: (opts: RefundOpts) => Promise<RefundResult>;
}
function defaultDeps(): TikTokOpDeps {
  return { refund: (opts) => refundUsdcToPayer(opts) };
}

const nowIso = () => new Date().toISOString();

export function getOpJob(id: string): TikTokOpJobRow | null {
  const row = db.prepare("SELECT * FROM tiktok_op_jobs WHERE id = ?").get(id) as TikTokOpJobRow | undefined;
  return row || null;
}

export interface CreateOpJobInput {
  op: TikTokOpName;
  account_id: string;
  owner: string;
  paymentSignature: string | null;
  paymentChain: "solana" | "base" | null;
  chargedUsdc: number | null;
}

/**
 * Insert the pending op job and kick off the worker. `run` is a thunk that
 * performs the actual browser op (it closes over the cookies + op args, held
 * in-memory — never persisted). Returns the row so the handler can 202.
 */
export function createOpJob(
  input: CreateOpJobInput,
  run: () => Promise<TikTokOpResult<any>>,
  deps: TikTokOpDeps = defaultDeps()
): TikTokOpJobRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tiktok_op_jobs
       (id, op, account_id, owner, payment_signature, payment_chain, charged_usdc, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    input.op,
    input.account_id,
    input.owner,
    input.paymentSignature,
    input.paymentChain,
    input.chargedUsdc,
    // ISO 'T' (not SQLite's space default) so created_at sorts against the
    // recovery cutoff lexicographically — same trap noted in domain-registration.
    new Date().toISOString()
  );
  scheduleWorker(id, run, deps);
  return getOpJob(id)!;
}

function scheduleWorker(id: string, run: () => Promise<TikTokOpResult<any>>, deps: TikTokOpDeps): void {
  setImmediate(() => {
    runOpJob(id, run, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE tiktok_op_jobs SET status='running', error=?, error_code='worker_exception', started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('pending','running')"
        ).run(String(e?.message || e), nowIso(), id);
      } catch {
        /* recovery sweep will handle it */
      }
    });
  });
}

export async function runOpJob(
  jobId: string,
  run: () => Promise<TikTokOpResult<any>>,
  deps: TikTokOpDeps = defaultDeps()
): Promise<void> {
  const job = getOpJob(jobId);
  if (!job) throw new Error(`tiktok_op_job ${jobId} not found`);
  if (job.status !== "pending") return; // idempotency

  db.prepare("UPDATE tiktok_op_jobs SET status='running', started_at=? WHERE id=? AND status='pending'")
    .run(nowIso(), jobId);

  let result: TikTokOpResult<any>;
  try {
    result = await run();

    // A readiness failure means the page never delivered the controls we needed.
    // The dominant cause is a burned residential exit: measured directly, an
    // account's pinned exit could not deliver TikTok's JS bundles while a fresh
    // session key rendered the same page, logged in, with identical cookies and
    // browser configuration — and switching back failed again.
    //
    // So move the account to a different exit and run once more, rather than
    // charging for a diagnosis the caller can do nothing with. These ops are
    // idempotent by design (a re-follow or re-like is a no-op), which is what
    // makes retrying safe here and not for posts.
    if (!result.success && result.error_code === "NOT_READY") {
      rotateProxyExit(job.account_id);
      console.warn(`[tiktok-op] ${job.op} hit NOT_READY on job ${jobId} — retrying on a fresh exit`);
      result = await run();
    }
  } catch (e: any) {
    // The op threw. These ops are safe to retry, so fail + refund (no
    // reconcile) — the caller re-runs; a re-follow/re-like/etc. is a no-op.
    const reason = `op threw: ${e?.message || e}`;
    markFailed(jobId, "op_exception", reason);
    await issueRefund(getOpJob(jobId)!, deps, reason);
    return;
  }

  if (result.success) {
    // A successful op is the strongest evidence the session still works, and
    // it is what makes "which of my accounts are alive" answerable without
    // spending a probe on each one.
    try { noteSuccess(job.account_id); } catch { /* health is not worth failing an op over */ }
    db.prepare("UPDATE tiktok_op_jobs SET status='done', result_json=?, completed_at=? WHERE id=?")
      .run(result.data != null ? JSON.stringify(result.data) : null, nowIso(), jobId);
    return;
  }

  const code = result.error_code || "UNKNOWN";
  const reason = `${result.error || "op failed"} [${code}]`;
  try { noteFailure(job.account_id, code); } catch { /* as above */ }
  markFailed(jobId, code, reason);
  await issueRefund(getOpJob(jobId)!, deps, reason);
}

function markFailed(jobId: string, code: string, message: string): void {
  db.prepare("UPDATE tiktok_op_jobs SET status='failed', error=?, error_code=?, completed_at=? WHERE id=?")
    .run(message, code, nowIso(), jobId);
}

async function issueRefund(job: TikTokOpJobRow, deps: TikTokOpDeps, reason: string): Promise<void> {
  if (!job.payment_signature || !job.payment_chain || job.charged_usdc == null) {
    db.prepare("UPDATE tiktok_op_jobs SET refund_status='manual_needed' WHERE id=?").run(job.id);
    console.error("[tiktok-op] [REFUND NEEDED] missing payment context", { jobId: job.id, op: job.op });
    return;
  }
  try {
    const result = await deps.refund({
      chain: job.payment_chain,
      payer: job.owner,
      amountUsdc: job.charged_usdc,
      originalPaymentSignature: job.payment_signature,
      reason: `tiktok ${job.op} failed: ${reason}`,
      endpoint: `POST /social/tiktok/${job.op}`,
    });
    db.prepare("UPDATE tiktok_op_jobs SET refund_id=?, refund_status=? WHERE id=?")
      .run(result.refundId, result.ok ? "sent" : "failed", job.id);
  } catch (e: any) {
    db.prepare("UPDATE tiktok_op_jobs SET refund_status='failed' WHERE id=?").run(job.id);
    console.error("[tiktok-op] auto-refund threw", { jobId: job.id, error: e?.message || String(e) });
  }
}

// ─── Crash recovery ───
// No in-memory `run` thunk survives a restart, and these ops are safe to retry,
// so any stuck job (pending = never ran; running = may have run) is failed +
// refunded; the caller re-runs. (Contrast posts, which must reconcile to avoid a
// double-post.)
const STUCK_AGE_MS = 10 * 60 * 1000;

export async function recoverStuckTikTokOps(deps: TikTokOpDeps = defaultDeps()): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
  const stuck = db
    .prepare("SELECT * FROM tiktok_op_jobs WHERE status IN ('pending','running') AND created_at < ? ORDER BY created_at ASC")
    .all(cutoff) as TikTokOpJobRow[];
  if (stuck.length === 0) return;
  console.log(`[tiktok-op] failing+refunding ${stuck.length} stuck op job(s) on startup`);
  for (const job of stuck) {
    try {
      markFailed(job.id, "server_restarted", "server restarted before the op completed — safe to retry");
      await issueRefund(getOpJob(job.id)!, deps, "server restarted");
    } catch (e: any) {
      console.error("[tiktok-op] recovery pass failed", { jobId: job.id, error: e?.message || String(e) });
    }
  }
}

// How often to re-sweep while the process runs. The startup pass only catches
// jobs orphaned by a RESTART; on its own it cannot terminalize a job that wedges
// in-process — a worker exception outside runOpJob leaves status='running', and
// a job waiting on the browser semaphore can outlive its own cutoff. Either way
// the row sits non-terminal forever: the poll endpoint returns done=false
// indefinitely, the CLI gives up after six minutes saying the work "continues
// server-side" about work that is permanently dead, and the payer is never
// refunded. Posts already had this sweep (audit #72); the five paid ops that
// share this runner never got it.
const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let recoverySweepTimer: ReturnType<typeof setInterval> | null = null;

export function startTikTokOpsRecovery(): void {
  setImmediate(() => {
    recoverStuckTikTokOps().catch((e) => console.error("[tiktok-op] startup recovery error:", e?.message || String(e)));
  });
  // Arm the recurring sweep once. unref() so the timer never keeps the process
  // (or a test runner) alive on its own.
  if (!recoverySweepTimer) {
    recoverySweepTimer = setInterval(() => {
      recoverStuckTikTokOps().catch((e) => console.error("[tiktok-op] recovery sweep error:", e?.message || String(e)));
    }, RECOVERY_SWEEP_INTERVAL_MS);
    recoverySweepTimer.unref?.();
  }
}
