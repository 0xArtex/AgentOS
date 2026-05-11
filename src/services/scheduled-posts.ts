/**
 * Server-side scheduled social posts.
 *
 * Agents call POST /social/scheduled with x402 payment at the post's full
 * price. The payment commits to the schedule — at fire time the worker
 * (PR 3) calls the existing internal `postTweet`/etc. functions directly,
 * which have NO paywall (paywalls are on the HTTP routes, not the functions).
 * No managed wallet required, no second signing event, no spending policy
 * infrastructure — just standard x402 at schedule time.
 *
 * Cancellation policy: scheduled posts are non-refundable once committed.
 * Same model as Buffer / Hootsuite / late-cancel Uber. Add refund logic
 * later if real users complain.
 */
import { db } from "../db";
import { randomUUID } from "crypto";

export type ScheduleAction = "post" | "post_thread" | "post_media";

export interface MediaPayload {
  image_base64?: string;
  image_url?: string;
  video_base64?: string;
  video_url?: string;
}

export interface SchedulePayload {
  text?: string;
  texts?: string[];
  media?: MediaPayload[];
  community_id?: string;
}

export interface CreateScheduledRequest {
  wallet: string;
  registered_account_id: string;
  platform: "twitter";
  action: ScheduleAction;
  payload: SchedulePayload;
  post_at: string;                                    // ISO 8601
  paid_amount_usdc: number;
}

export interface CreateScheduledResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Validate the payload shape against the action. We catch obvious mismatches
 * here so the worker doesn't waste a browser launch on malformed inputs.
 */
function validatePayload(action: ScheduleAction, payload: SchedulePayload): string | null {
  if (action === "post") {
    if (!payload.text || !payload.text.trim()) return "post requires non-empty text";
    if (payload.text.length > 280) return `post text exceeds 280 chars (got ${payload.text.length})`;
  } else if (action === "post_thread") {
    if (!Array.isArray(payload.texts) || payload.texts.length === 0) return "post_thread requires non-empty texts array";
    if (payload.texts.length > 25) return `post_thread length capped at 25 (got ${payload.texts.length})`;
    for (let i = 0; i < payload.texts.length; i++) {
      const t = payload.texts[i];
      if (!t || !t.trim()) return `post_thread tweet ${i + 1} is empty`;
      if (t.length > 280) return `post_thread tweet ${i + 1} exceeds 280 chars (got ${t.length})`;
    }
  } else if (action === "post_media") {
    if (!payload.text || !payload.text.trim()) return "post_media requires non-empty text";
    if (payload.text.length > 280) return `post_media text exceeds 280 chars (got ${payload.text.length})`;
    if (!Array.isArray(payload.media) || payload.media.length === 0) return "post_media requires non-empty media array (1-4 images OR 1 video)";
    if (payload.media.length > 4) return `post_media: max 4 items (got ${payload.media.length})`;
    const videos = payload.media.filter(m => m.video_base64 || m.video_url);
    const images = payload.media.filter(m => m.image_base64 || m.image_url);
    if (videos.length > 0 && images.length > 0) return "post_media: cannot mix images and video";
    if (videos.length > 1) return `post_media: max 1 video (got ${videos.length})`;
    for (let i = 0; i < payload.media.length; i++) {
      const m = payload.media[i];
      if (!m.image_base64 && !m.image_url && !m.video_base64 && !m.video_url) {
        return `post_media: media item ${i + 1} has no image_*/video_* fields`;
      }
    }
  }
  if (payload.community_id !== undefined && !/^\d{15,30}$/.test(payload.community_id)) {
    return `community_id must be a numeric ID (15-30 digits, got: ${payload.community_id})`;
  }
  return null;
}

/**
 * Validate post_at: must be a valid ISO 8601 future timestamp. Allow 1
 * minute of clock skew so "schedule for now" calls don't 400 on tiny
 * clock differences between client and server.
 */
function validatePostAt(postAt: string): string | null {
  const ms = Date.parse(postAt);
  if (Number.isNaN(ms)) return `post_at "${postAt}" is not a valid ISO 8601 date`;
  const skewMs = 60_000;
  if (ms < Date.now() - skewMs) return `post_at "${postAt}" is in the past`;
  return null;
}

export function createScheduled(req: CreateScheduledRequest): CreateScheduledResult {
  if (req.platform !== "twitter") return { success: false, error: "Only twitter is supported right now" };

  const payloadErr = validatePayload(req.action, req.payload);
  if (payloadErr) return { success: false, error: payloadErr };

  const postAtErr = validatePostAt(req.post_at);
  if (postAtErr) return { success: false, error: postAtErr };

  // Verify the wallet owns the registered_account_id BEFORE accepting payment-
  // adjacent state. We don't decrypt anything — just confirm ownership row exists.
  const owned = db
    .prepare(
      `SELECT id, status FROM social_registered_accounts WHERE id=? AND wallet=?`
    )
    .get(req.registered_account_id, req.wallet) as { id: string; status: string } | undefined;
  if (!owned) {
    return { success: false, error: `Registered account "${req.registered_account_id}" not found for this wallet. Run \`palmyr twitter register <username>\` first.` };
  }
  if (owned.status === "revoked") {
    return { success: false, error: `Registered account "${req.registered_account_id}" was revoked. Re-register to schedule new posts.` };
  }

  const id = randomUUID().replace(/-/g, "");
  db.prepare(
    `INSERT INTO scheduled_social_posts (
      id, wallet, registered_account_id, platform, action, payload_json,
      post_at, paid_amount_usdc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.wallet,
    req.registered_account_id,
    req.platform,
    req.action,
    JSON.stringify(req.payload),
    req.post_at,
    req.paid_amount_usdc
  );

  return { success: true, id };
}

export interface ScheduledPostSummary {
  id: string;
  registered_account_id: string;
  platform: string;
  action: ScheduleAction;
  payload: SchedulePayload;
  post_at: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  retry_count: number;
  paid_amount_usdc: number;
  created_at: string;
  attempted_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  error: string | null;
  result: any | null;
}

export interface ListScheduledFilter {
  wallet: string;
  account_id?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  from?: string;                                       // ISO 8601 — filter post_at >= from
  to?: string;                                         // ISO 8601 — filter post_at <= to
  limit?: number;
}

export function listScheduled(filter: ListScheduledFilter): ScheduledPostSummary[] {
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  const rows = db
    .prepare(
      `SELECT * FROM scheduled_social_posts
       WHERE wallet = ?
         AND (? IS NULL OR registered_account_id = ?)
         AND (? IS NULL OR status = ?)
         AND (? IS NULL OR post_at >= ?)
         AND (? IS NULL OR post_at <= ?)
       ORDER BY post_at ASC
       LIMIT ?`
    )
    .all(
      filter.wallet,
      filter.account_id || null,
      filter.account_id || null,
      filter.status || null,
      filter.status || null,
      filter.from || null,
      filter.from || null,
      filter.to || null,
      filter.to || null,
      limit
    ) as any[];
  return rows.map(rowToSummary);
}

/**
 * Redact base64 media blobs from a payload before returning it to the user.
 * The worker reads payload_json directly from the row, so it still gets the
 * full data — only the user-facing list/cancel responses see redacted form.
 * Without this, `palmyr twitter queue` dumps ~1.5MB of base64 per scheduled
 * media post (an image post is ~1.3MB raw → ~1.7MB base64).
 */
function redactPayloadForSummary(payload: SchedulePayload): SchedulePayload {
  if (!payload.media || payload.media.length === 0) return payload;
  const redacted: SchedulePayload = { ...payload };
  redacted.media = payload.media.map(m => {
    const out: MediaPayload = {};
    if (m.image_url) out.image_url = m.image_url;
    if (m.video_url) out.video_url = m.video_url;
    if (m.image_base64) out.image_base64 = `<image base64 omitted, ${m.image_base64.length} chars>`;
    if (m.video_base64) out.video_base64 = `<video base64 omitted, ${m.video_base64.length} chars>`;
    return out;
  });
  return redacted;
}

function rowToSummary(row: any): ScheduledPostSummary {
  const payload = JSON.parse(row.payload_json) as SchedulePayload;
  return {
    id: row.id,
    registered_account_id: row.registered_account_id,
    platform: row.platform,
    action: row.action,
    payload: redactPayloadForSummary(payload),
    post_at: row.post_at,
    status: row.status,
    retry_count: row.retry_count,
    paid_amount_usdc: row.paid_amount_usdc,
    created_at: row.created_at,
    attempted_at: row.attempted_at,
    completed_at: row.completed_at,
    failed_at: row.failed_at,
    cancelled_at: row.cancelled_at,
    error: row.error,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export interface CancelResult {
  success: boolean;
  cancelled?: boolean;
  status?: string;
  error?: string;
}

/**
 * Cancel a pending scheduled post. Idempotent for already-cancelled.
 * In-progress / completed / failed cannot be cancelled (the work is done
 * or in-flight). Wallet-scoped — silently 404s for other wallets' items.
 */
export function cancelScheduled(wallet: string, id: string): CancelResult {
  const row = db
    .prepare(`SELECT id, status FROM scheduled_social_posts WHERE id=? AND wallet=?`)
    .get(id, wallet) as { id: string; status: string } | undefined;
  if (!row) return { success: false, error: `No scheduled post "${id}" for this wallet` };

  if (row.status === "cancelled") return { success: true, cancelled: false, status: row.status };
  if (row.status !== "pending") {
    return {
      success: false,
      cancelled: false,
      status: row.status,
      error: `Cannot cancel: status is "${row.status}" (only pending items are cancellable)`,
    };
  }

  // Atomic flip — only succeeds if the row is still pending.
  const result = db
    .prepare(
      `UPDATE scheduled_social_posts
       SET status='cancelled', cancelled_at=?
       WHERE id=? AND wallet=? AND status='pending'`
    )
    .run(new Date().toISOString(), id, wallet);

  if (result.changes !== 1) {
    return { success: false, cancelled: false, error: "Cancel raced with another transition (item was claimed by worker)" };
  }
  return { success: true, cancelled: true, status: "cancelled" };
}

/* ─── Worker-facing helpers (used by PR 3) ────────────────────────────── */

export function getDueScheduled(now: Date = new Date(), limit: number = 50): ScheduledPostSummary[] {
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM scheduled_social_posts
       WHERE status='pending' AND post_at <= ?
       ORDER BY post_at ASC
       LIMIT ?`
    )
    .all(nowIso, limit) as any[];
  return rows.map(rowToSummary);
}

/**
 * Claim a scheduled item — atomic flip from 'pending' to 'in_progress'.
 * Returns true if claimed (worker may now dispatch), false if another worker
 * grabbed it first or if the item was cancelled.
 */
export function claimScheduled(id: string): boolean {
  const result = db
    .prepare(
      `UPDATE scheduled_social_posts
       SET status='in_progress', attempted_at=?
       WHERE id=? AND status='pending'`
    )
    .run(new Date().toISOString(), id);
  return result.changes === 1;
}

export function markScheduledCompleted(id: string, result: any): void {
  db.prepare(
    `UPDATE scheduled_social_posts
     SET status='completed', completed_at=?, result_json=?
     WHERE id=?`
  ).run(new Date().toISOString(), JSON.stringify(result), id);
}

/**
 * Failed dispatch — retryable errors get re-scheduled with exponential backoff
 * (10/20/40 min, max 3 attempts) by flipping back to 'pending' with a future
 * post_at. Terminal errors move to 'failed'.
 */
export function markScheduledFailed(id: string, error: string, retryable: boolean): void {
  const row = db
    .prepare(`SELECT retry_count FROM scheduled_social_posts WHERE id=?`)
    .get(id) as { retry_count: number } | undefined;
  if (!row) return;

  if (retryable && row.retry_count < 3) {
    const nextRetry = row.retry_count + 1;
    const backoffMin = Math.pow(2, nextRetry) * 5;             // 10, 20, 40 min
    const newPostAt = new Date(Date.now() + backoffMin * 60_000).toISOString();
    db.prepare(
      `UPDATE scheduled_social_posts
       SET status='pending', retry_count=?, post_at=?, error=?
       WHERE id=?`
    ).run(nextRetry, newPostAt, error, id);
    return;
  }

  db.prepare(
    `UPDATE scheduled_social_posts
     SET status='failed', failed_at=?, error=?
     WHERE id=?`
  ).run(new Date().toISOString(), error, id);
}
