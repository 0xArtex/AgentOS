/**
 * Async TikTok video posting.
 *
 * Publishing a TikTok video drives a headless browser through the Studio upload
 * flow — launch, route through the residential proxy, upload the file, wait for
 * the caption editor (up to 90s), submit, and wait for the publish confirmation
 * (up to 60s). That routinely takes 2-5 minutes, which is LONGER than
 * Cloudflare's tunnel HTTP timeout (~100s): the synchronous handler would settle
 * the payment, then the caller's connection would 524 before the post finished —
 * the agent is charged but never learns whether its video posted (observed in
 * prod 2026-06-19).
 *
 * This service decouples the post from the request, modelled on
 * `domain-registration` (the canonical async-operation pattern), and adds the
 * two things money + external side-effects demand:
 *
 *   1. AUTO-REFUND on definitive failure. If the post provably did not publish
 *      (pre-submit error, or reconciliation finds no matching video) the settled
 *      USDC is sent back automatically and idempotently (refundUsdcToPayer dedups
 *      on the payment signature).
 *
 *   2. RECONCILIATION on the unknown case. A post that clicks Submit but never
 *      sees a confirmation (UI_TIMEOUT), or that throws mid-flight, leaves us not
 *      knowing whether the video published. We never blind-refund (could refund a
 *      post that landed) or blind-fail. Instead we ask TikTok: re-open a session
 *      and scrape the Studio content manager for a video matching the caption
 *      (checkPostedByCaption). found → posted, not-found → refund, unresolved →
 *      defer to manual ops.
 *
 * Lifecycle:  pending → publishing → (posted | failed)
 *
 *   POST /social/tiktok/post → createPostJob (status='pending') → 202
 *     { operation_id, status, poll_url }, worker kicked via setImmediate.
 *   Worker → flips 'publishing', runs postVideo, writes video_url on success, or
 *     reconciles/refunds on failure.
 *   GET /social/tiktok/operations/:id → poll until status is terminal.
 *
 * The video bytes + session cookies are passed to the worker IN-MEMORY (closure)
 * and are deliberately NOT persisted (a 10MB base64 blob + session credentials
 * at rest is not worth it). Consequence for crash recovery: a 'pending' job
 * orphaned by a restart never launched the browser (definitely not posted) →
 * refund; a 'publishing' job orphaned by a restart can't be auto-reconciled
 * (cookies are gone) → flagged for manual review, NOT auto-refunded (it may have
 * posted). Worker-level reconciliation (the common case — the op finishes and
 * just can't confirm) keeps its in-memory cookies and reconciles fully.
 */
import { randomUUID } from "crypto";
import { db } from "../db";
import {
  postVideo as defaultPostVideo,
  checkPostedByCaption as defaultCheckPosted,
  type TikTokPostRequest,
  type TikTokOpResult,
} from "./tiktok-operations";
import { refundUsdcToPayer, RefundOpts, RefundResult } from "./refund";

export type TikTokPostStatus = "pending" | "publishing" | "posted" | "failed";

export interface TikTokPostJobRow {
  id: string;
  account_id: string;
  owner: string;
  caption: string;
  privacy: number | null;
  schedule_at: string | null;
  payment_signature: string | null;
  payment_chain: "solana" | "base" | null;
  charged_usdc: number | null;
  status: TikTokPostStatus;
  video_id: string | null;
  video_url: string | null;
  error: string | null;
  error_code: string | null;
  refund_id: string | null;
  refund_status: string | null; // 'sent' | 'failed' | 'manual_needed' | null
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_post_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    caption TEXT NOT NULL,
    privacy INTEGER,
    schedule_at TEXT,
    payment_signature TEXT,
    payment_chain TEXT,
    charged_usdc REAL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','publishing','posted','failed')),
    video_id TEXT,
    video_url TEXT,
    error TEXT,
    error_code TEXT,
    refund_id TEXT,
    refund_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','utc')),
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tiktok_post_owner ON tiktok_post_jobs(owner);
  CREATE INDEX IF NOT EXISTS idx_tiktok_post_status ON tiktok_post_jobs(status);
`);

// ─── Dependency injection (testability) ───
// The state machine is pure DB + these side-effecting deps. Tests inject fakes
// to exercise every branch without launching a browser or touching the treasury.
export interface TikTokPostDeps {
  /** Drive the Studio upload+publish flow. Resolves with success/failure; may throw on crash/launch error. */
  postVideo: (req: TikTokPostRequest) => Promise<TikTokOpResult<{ video_url?: string; video_id?: string; scheduled_at?: string }>>;
  /** Reconciliation oracle: did a video with this caption actually publish? */
  checkPosted: (req: { account_id: string; proxy_session_id?: string; country?: string; cookies: any[]; caption: string }) => Promise<TikTokOpResult<{ determined: boolean; posted: boolean; video_url?: string; video_id?: string }>>;
  /** Issue the on-chain refund (idempotent on the payment signature). */
  refund: (opts: RefundOpts) => Promise<RefundResult>;
}

function defaultDeps(): TikTokPostDeps {
  return {
    postVideo: defaultPostVideo,
    checkPosted: defaultCheckPosted,
    refund: (opts) => refundUsdcToPayer(opts),
  };
}

// Error codes from a postVideo failure that are AMBIGUOUS about whether the
// video published (the op may have clicked Submit). These trigger reconciliation
// rather than a blind refund. Everything else is pre-submit ⇒ definitively not
// posted ⇒ safe to fail + refund directly.
const AMBIGUOUS_CODES = new Set(["UI_TIMEOUT", "UNKNOWN"]);

// ─── Job CRUD ───

export function getPostJob(id: string): TikTokPostJobRow | null {
  const row = db.prepare("SELECT * FROM tiktok_post_jobs WHERE id = ?").get(id) as TikTokPostJobRow | undefined;
  return row || null;
}

export interface CreatePostJobInput {
  account_id: string;
  owner: string;
  caption: string;
  privacy: number | null;
  schedule_at: string | null;
  paymentSignature: string | null;
  paymentChain: "solana" | "base" | null;
  chargedUsdc: number | null;
}

/**
 * Insert the pending job and kick off the background worker. `request` carries
 * the full post payload (video bytes + cookies) and is held IN-MEMORY by the
 * worker closure — never persisted. Returns the row so the handler can respond
 * 202 immediately.
 */
export function createPostJob(
  input: CreatePostJobInput,
  request: TikTokPostRequest,
  deps: TikTokPostDeps = defaultDeps()
): TikTokPostJobRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tiktok_post_jobs
       (id, account_id, owner, caption, privacy, schedule_at, payment_signature, payment_chain, charged_usdc, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    input.account_id,
    input.owner,
    input.caption,
    input.privacy,
    input.schedule_at,
    input.paymentSignature,
    input.paymentChain,
    input.chargedUsdc,
    // ISO-8601 with 'T' (not SQLite's space-separated datetime() default) so it
    // sorts lexicographically against the toISOString() recovery cutoff. See the
    // identical note in domain-registration.ts.
    new Date().toISOString()
  );
  scheduleWorker(id, request, deps);
  return getPostJob(id)!;
}

// Run the worker out-of-band. A throw out of the worker must never crash the
// process — persist it so the poller sees a definite state and recovery can act.
function scheduleWorker(id: string, request: TikTokPostRequest, deps: TikTokPostDeps): void {
  setImmediate(() => {
    runTikTokPost(id, request, deps).catch((e) => {
      try {
        db.prepare(
          "UPDATE tiktok_post_jobs SET status='publishing', error=?, error_code='worker_exception', started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('pending','publishing')"
        ).run(String(e?.message || e), nowIso(), id);
      } catch {
        /* recovery sweep will handle it */
      }
    });
  });
}

// ─── Worker ───

const nowIso = () => new Date().toISOString();

export async function runTikTokPost(
  jobId: string,
  request: TikTokPostRequest,
  deps: TikTokPostDeps = defaultDeps()
): Promise<void> {
  const job = getPostJob(jobId);
  if (!job) throw new Error(`tiktok_post_job ${jobId} not found`);
  // Idempotency: only a fresh 'pending' job advances.
  if (job.status !== "pending") return;

  db.prepare("UPDATE tiktok_post_jobs SET status='publishing', started_at=? WHERE id=? AND status='pending'")
    .run(nowIso(), jobId);

  let result: TikTokOpResult<{ video_url?: string; video_id?: string; scheduled_at?: string }>;
  try {
    result = await deps.postVideo(request);
  } catch (postErr: any) {
    // The op threw mid-flight — unknown whether the video published. Reconcile
    // rather than guess (scheduled posts can't be scraped → manual).
    console.error("[tiktok-post] postVideo threw — reconciling", {
      jobId, error: postErr?.message || String(postErr),
    });
    await reconcile(jobId, request, deps, `post_call_threw: ${postErr?.message || postErr}`);
    return;
  }

  if (result.success) {
    markPosted(jobId, result.data || {});
    return;
  }

  // postVideo reported failure. If the error is AMBIGUOUS about whether Submit
  // landed, reconcile with TikTok before refunding. Otherwise it's a pre-submit
  // failure (never posted) → fail + refund directly.
  const code = result.error_code || "UNKNOWN";
  const reason = `${result.error || "post failed"} [${code}]`;
  if (AMBIGUOUS_CODES.has(code)) {
    // Submit may have landed — reconcile rather than blind-refund. reconcile()
    // itself handles the scheduled case (can't scrape a not-yet-live post →
    // manual review) vs the instant case (scrape the content manager).
    await reconcile(jobId, request, deps, reason);
    return;
  }
  // Pre-submit failure (bad input, launch/upload/schedule/session error) — the
  // video definitively never published, so fail + refund directly.
  markFailed(jobId, code, reason);
  await issueRefund(getPostJob(jobId)!, deps, reason);
}

function markPosted(jobId: string, data: { video_url?: string; video_id?: string; scheduled_at?: string }): void {
  db.prepare(
    "UPDATE tiktok_post_jobs SET status='posted', video_url=COALESCE(?, video_url), video_id=COALESCE(?, video_id), completed_at=? WHERE id=?"
  ).run(data.video_url ?? null, data.video_id ?? null, nowIso(), jobId);
}

function markFailed(jobId: string, code: string, message: string): void {
  db.prepare(
    "UPDATE tiktok_post_jobs SET status='failed', error=?, error_code=?, completed_at=? WHERE id=?"
  ).run(message, code, nowIso(), jobId);
}

// Issue the auto-refund for a failed job and record the result. Idempotent
// end-to-end (refundUsdcToPayer dedups on the payment signature).
async function issueRefund(job: TikTokPostJobRow, deps: TikTokPostDeps, reason: string): Promise<void> {
  if (!job.payment_signature || !job.payment_chain || job.charged_usdc == null) {
    db.prepare("UPDATE tiktok_post_jobs SET refund_status='manual_needed' WHERE id=?").run(job.id);
    console.error("[tiktok-post] [REFUND NEEDED] missing payment context for auto-refund", {
      jobId: job.id, signature: job.payment_signature, chain: job.payment_chain, amount: job.charged_usdc,
    });
    return;
  }
  try {
    const result = await deps.refund({
      chain: job.payment_chain,
      payer: job.owner,
      amountUsdc: job.charged_usdc,
      originalPaymentSignature: job.payment_signature,
      reason: `tiktok post failed: ${reason}`,
      endpoint: "POST /social/tiktok/post",
    });
    db.prepare("UPDATE tiktok_post_jobs SET refund_id=?, refund_status=? WHERE id=?")
      .run(result.refundId, result.ok ? "sent" : "failed", job.id);
    if (!result.ok) {
      console.error("[tiktok-post] auto-refund deferred (treasury issue)", { jobId: job.id, reason: result.reason });
    }
  } catch (e: any) {
    db.prepare("UPDATE tiktok_post_jobs SET refund_status='failed' WHERE id=?").run(job.id);
    console.error("[tiktok-post] auto-refund threw", { jobId: job.id, error: e?.message || String(e) });
  }
}

/**
 * Resolve a job of unknown outcome by asking TikTok (scrape the content manager
 * for the caption). Used when postVideo throws or returns an ambiguous code.
 *   posted at TikTok        → posted (no refund — the payer got their post)
 *   provably not posted     → failed + refund
 *   could not determine     → leave 'publishing' (manual ops / next pass)
 */
async function reconcile(
  jobId: string,
  request: TikTokPostRequest,
  deps: TikTokPostDeps,
  reasonIfFailed: string
): Promise<void> {
  const job = getPostJob(jobId);
  if (!job || (job.status !== "publishing" && job.status !== "pending")) return;

  // A scheduled post isn't live yet, so it can't be scraped — can't reconcile.
  if (request.schedule_at) {
    db.prepare(
      "UPDATE tiktok_post_jobs SET status='publishing', error=?, error_code='reconcile_unresolved_scheduled', refund_status='manual_needed', started_at=COALESCE(started_at, ?) WHERE id=?"
    ).run(reasonIfFailed, nowIso(), jobId);
    console.error("[tiktok-post] [RECONCILE UNRESOLVED] scheduled post ambiguous — manual review", { jobId });
    return;
  }

  let check: TikTokOpResult<{ determined: boolean; posted: boolean; video_url?: string; video_id?: string }>;
  try {
    check = await deps.checkPosted({
      account_id: request.account_id,
      proxy_session_id: request.proxy_session_id,
      country: request.country,
      cookies: request.cookies,
      caption: request.caption,
    });
  } catch {
    check = { success: true, data: { determined: false, posted: false } };
  }

  const c = check.data;
  if (c?.determined && c.posted) {
    markPosted(jobId, { video_url: c.video_url, video_id: c.video_id });
    return;
  }
  if (c?.determined && !c.posted) {
    // Provably not posted ⇒ definitive failure ⇒ refund.
    markFailed(jobId, "reconciled_not_posted", reasonIfFailed);
    await issueRefund(getPostJob(jobId)!, deps, reasonIfFailed);
    return;
  }

  // Couldn't determine (session wouldn't open / scrape failed). Don't blind-
  // refund on uncertainty. Leave 'publishing' with a breadcrumb for manual ops.
  db.prepare(
    "UPDATE tiktok_post_jobs SET status='publishing', error=?, error_code='reconcile_unresolved', refund_status='manual_needed', started_at=COALESCE(started_at, ?) WHERE id=?"
  ).run(reasonIfFailed, nowIso(), jobId);
  console.error("[tiktok-post] [RECONCILE UNRESOLVED] could not determine post outcome", { jobId });
}

// ─── Crash recovery ───
//
// Resolve jobs left dangling by a previous process. Unlike the worker-level
// reconcile, recovery has NO in-memory request (video bytes + cookies are gone),
// so it cannot re-run a post or scrape for reconciliation.
//   - 'pending'    → the browser never launched ⇒ definitely not posted ⇒ refund.
//   - 'publishing' → may or may not have posted, and we can't scrape without
//                    cookies ⇒ flag manual review, do NOT auto-refund (avoids
//                    refunding a post that actually landed). Rare (a crash inside
//                    the ~2-5 min publish window).
const STUCK_AGE_MS = 10 * 60 * 1000; // > the ~2-5 min publish window + margin

export async function recoverStuckTikTokPosts(deps: TikTokPostDeps = defaultDeps()): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_AGE_MS).toISOString();
  const stuck = db
    .prepare("SELECT * FROM tiktok_post_jobs WHERE status IN ('pending','publishing') AND created_at < ? ORDER BY created_at ASC")
    .all(cutoff) as TikTokPostJobRow[];
  if (stuck.length === 0) return;

  console.log(`[tiktok-post] reconciling ${stuck.length} stuck post job(s) on startup`);
  for (const job of stuck) {
    try {
      if (job.status === "pending") {
        markFailed(job.id, "server_restarted_before_publish", "server restarted before the post began — never published");
        await issueRefund(getPostJob(job.id)!, deps, "server restarted before publish");
      } else {
        // 'publishing' — ambiguous and unreconcilable post-restart (no cookies).
        db.prepare(
          "UPDATE tiktok_post_jobs SET status='failed', error=?, error_code='server_restarted_mid_publish', refund_status='manual_needed', completed_at=? WHERE id=?"
        ).run("server restarted mid-publish — may or may not have posted; manual review", nowIso(), job.id);
        console.error("[tiktok-post] [MANUAL REVIEW] post job orphaned mid-publish — not auto-refunded (may have posted)", { jobId: job.id, account_id: job.account_id });
      }
    } catch (e: any) {
      console.error("[tiktok-post] recovery pass failed for job", { jobId: job.id, error: e?.message || String(e) });
    }
  }
}

// Recovery is NOT an import side-effect (it issues refunds) — triggered once at
// startup from index.ts.
export function startTikTokPostRecovery(): void {
  setImmediate(() => {
    recoverStuckTikTokPosts().catch((e) =>
      console.error("[tiktok-post] startup recovery error:", e?.message || String(e))
    );
  });
}
