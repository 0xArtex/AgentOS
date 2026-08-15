/**
 * Async runner for the long X/Twitter browser image ops: avatar, banner.
 *
 * These drive a headless browser and — since the #342 FINALIZE-gate + 60s
 * set-image window + the verify-after-write profile re-read — can run ~60-90s
 * over a residential proxy, brushing Cloudflare's ~100s tunnel timeout that would
 * 524 the caller after payment settled. So they run as async operations sharing
 * the same envelope as TikTok ops: the route returns 202 { operation_id, poll_url }
 * immediately and a background worker does the work, auto-refunding on failure.
 *
 * SAFE TO RETRY: re-setting an avatar/banner to the same image is a no-op, so
 * like the TikTok simple ops there is NO reconciliation oracle — any failure
 * (including the ambiguous CONFIRMATION_PENDING, where the media uploaded but we
 * couldn't confirm the change) just fails + refunds, and the caller can safely
 * retry. Worst case on an ambiguous success is a tiny over-refund, never harm.
 *
 * Lifecycle: pending → running → (done | failed). The image bytes / cookies live
 * in the worker closure (the `run` thunk), never persisted — so a crash before /
 * while running just refunds (safe; the caller retries).
 *
 * This mirrors tiktok-ops-jobs.ts; the two are separate per-platform tables (as
 * TikTok already splits post-jobs from ops-jobs) rather than one generic table,
 * to avoid a migration/rename of the live tiktok_op_jobs path.
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import { refundUsdcToPayer, RefundOpts, RefundResult } from "./refund";
import type { OpResult } from "./social-operations";

export type XOpName = "avatar" | "banner";
export type XOpJobStatus = "pending" | "running" | "done" | "failed";

export interface XOpJobProgress {
  step: string;
  message: string;
  updated_at: string;
}

export type XOpProgressReporter = (step: string, message: string) => void;
type XOpRunner = (reportProgress: XOpProgressReporter) => Promise<OpResult<any>>;

// Progress is intentionally ephemeral, just like the in-memory browser thunk.
// A restart terminalizes the job through recovery, so there is no stale setup
// state to resume. Completed entries expire to keep this bounded.
const progressByJob = new Map<string, XOpJobProgress>();

function setXOpProgress(jobId: string, step: string, message: string): void {
  progressByJob.set(jobId, { step, message, updated_at: nowIso() });
}

export function getXOpJobProgress(jobId: string): XOpJobProgress | null {
  return progressByJob.get(jobId) || null;
}

export interface XOpJobRow {
  id: string;
  op: XOpName;
  account_id: string;
  owner: string;
  payment_signature: string | null;
  payment_chain: "solana" | "base" | null;
  charged_usdc: number | null;
  status: XOpJobStatus;
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
  CREATE TABLE IF NOT EXISTS x_op_jobs (
    id TEXT PRIMARY KEY,
    op TEXT NOT NULL CHECK(op IN ('avatar','banner')),
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
  CREATE INDEX IF NOT EXISTS idx_x_op_owner ON x_op_jobs(owner);
  CREATE INDEX IF NOT EXISTS idx_x_op_status ON x_op_jobs(status);
`);

export interface XOpDeps {
  refund: (opts: RefundOpts) => Promise<RefundResult>;
}
function defaultDeps(): XOpDeps {
  return { refund: (opts) => refundUsdcToPayer(opts) };
}

const nowIso = () => new Date().toISOString();

export function getXOpJob(id: string): XOpJobRow | null {
  const row = db.prepare("SELECT * FROM x_op_jobs WHERE id = ?").get(id) as XOpJobRow | undefined;
  return row || null;
}

export interface CreateXOpJobInput {
  op: XOpName;
  account_id: string;
  owner: string;
  paymentSignature: string | null;
  paymentChain: "solana" | "base" | null;
  chargedUsdc: number | null;
}

/**
 * Insert the pending op job and kick off the worker. `run` is a thunk that
 * performs the actual browser op (it closes over the cookies + image args, held
 * in-memory — never persisted). Returns the row so the handler can 202.
 */
export function createXOpJob(
  input: CreateXOpJobInput,
  run: XOpRunner,
  deps: XOpDeps = defaultDeps()
): XOpJobRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO x_op_jobs
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
  setXOpProgress(id, "queued", "Warming up account");
  scheduleWorker(id, run, deps);
  return getXOpJob(id)!;
}

function scheduleWorker(id: string, run: XOpRunner, deps: XOpDeps): void {
  setImmediate(() => {
    runXOpJob(id, run, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE x_op_jobs SET status='running', error=?, error_code='worker_exception', started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('pending','running')"
        ).run(String(e?.message || e), nowIso(), id);
      } catch {
        /* recovery sweep will handle it */
      }
    });
  });
}

export async function runXOpJob(
  jobId: string,
  run: XOpRunner,
  deps: XOpDeps = defaultDeps()
): Promise<void> {
  const job = getXOpJob(jobId);
  if (!job) throw new Error(`x_op_job ${jobId} not found`);
  if (job.status !== "pending") return; // idempotency

  db.prepare("UPDATE x_op_jobs SET status='running', started_at=? WHERE id=? AND status='pending'")
    .run(nowIso(), jobId);
  setXOpProgress(jobId, "warming_up", "Warming up account");

  let result: OpResult<any>;
  try {
    result = await run((step, message) => setXOpProgress(jobId, step, message));
  } catch (e: any) {
    // The op threw. These ops are safe to retry, so fail + refund (no reconcile)
    // — the caller re-runs; re-setting the same avatar/banner is a no-op.
    const reason = `op threw: ${e?.message || e}`;
    markFailed(jobId, "op_exception", reason);
    await issueRefund(getXOpJob(jobId)!, deps, reason);
    return;
  }

  if (result.success) {
    db.prepare("UPDATE x_op_jobs SET status='done', result_json=?, completed_at=? WHERE id=?")
      .run(result.data != null ? JSON.stringify(result.data) : null, nowIso(), jobId);
    setXOpProgress(jobId, "ready", "Account ready");
    const cleanup = setTimeout(() => progressByJob.delete(jobId), 60 * 60 * 1000);
    cleanup.unref?.();
    return;
  }

  const code = result.error_code || "UNKNOWN";
  const reason = `${result.error || "op failed"} [${code}]`;
  markFailed(jobId, code, reason);
  await issueRefund(getXOpJob(jobId)!, deps, reason);
}

function markFailed(jobId: string, code: string, message: string): void {
  db.prepare("UPDATE x_op_jobs SET status='failed', error=?, error_code=?, completed_at=? WHERE id=?")
    .run(message, code, nowIso(), jobId);
  setXOpProgress(jobId, "failed", "Setup needs attention");
  const cleanup = setTimeout(() => progressByJob.delete(jobId), 60 * 60 * 1000);
  cleanup.unref?.();
}

async function issueRefund(job: XOpJobRow, deps: XOpDeps, reason: string): Promise<void> {
  if (!job.payment_signature || !job.payment_chain || job.charged_usdc == null) {
    db.prepare("UPDATE x_op_jobs SET refund_status='manual_needed' WHERE id=?").run(job.id);
    console.error("[x-op] [REFUND NEEDED] missing payment context", { jobId: job.id, op: job.op });
    return;
  }
  try {
    const result = await deps.refund({
      chain: job.payment_chain,
      payer: job.owner,
      amountUsdc: job.charged_usdc,
      originalPaymentSignature: job.payment_signature,
      reason: `x ${job.op} failed: ${reason}`,
      endpoint: `POST /social/twitter/${job.op}`,
    });
    db.prepare("UPDATE x_op_jobs SET refund_id=?, refund_status=? WHERE id=?")
      .run(result.refundId, result.ok ? "sent" : "failed", job.id);
  } catch (e: any) {
    db.prepare("UPDATE x_op_jobs SET refund_status='failed' WHERE id=?").run(job.id);
    console.error("[x-op] auto-refund threw", { jobId: job.id, error: e?.message || String(e) });
  }
}

// ─── Crash recovery ───
// No in-memory `run` thunk survives a restart, and these ops are safe to retry,
// so any stuck job (pending = never ran; running = may have run) is failed +
// refunded; the caller re-runs.
const STUCK_AGE_MS = 10 * 60 * 1000;

export async function recoverStuckXOps(deps: XOpDeps = defaultDeps()): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
  const stuck = db
    .prepare("SELECT * FROM x_op_jobs WHERE status IN ('pending','running') AND created_at < ? ORDER BY created_at ASC")
    .all(cutoff) as XOpJobRow[];
  if (stuck.length === 0) return;
  console.log(`[x-op] failing+refunding ${stuck.length} stuck op job(s) on startup`);
  for (const job of stuck) {
    try {
      markFailed(job.id, "server_restarted", "server restarted before the op completed — safe to retry");
      await issueRefund(getXOpJob(job.id)!, deps, "server restarted");
    } catch (e: any) {
      console.error("[x-op] recovery pass failed", { jobId: job.id, error: e?.message || String(e) });
    }
  }
}

// Identical shape to the TikTok ops runner — the startup pass alone cannot
// terminalize a job that wedges in-process, so without this the row stays
// non-terminal forever and the payer is never refunded. Fixed in both places at
// once so the bug does not survive in whichever file was not being read.
const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let recoverySweepTimer: ReturnType<typeof setInterval> | null = null;

export function startXOpsRecovery(): void {
  setImmediate(() => {
    recoverStuckXOps().catch((e) => console.error("[x-op] startup recovery error:", e?.message || String(e)));
  });
  if (!recoverySweepTimer) {
    recoverySweepTimer = setInterval(() => {
      recoverStuckXOps().catch((e) => console.error("[x-op] recovery sweep error:", e?.message || String(e)));
    }, RECOVERY_SWEEP_INTERVAL_MS);
    recoverySweepTimer.unref?.();
  }
}
