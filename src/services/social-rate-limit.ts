/**
 * Server-side velocity caps for social-account operations.
 *
 * Why: platforms (TikTok especially) suspend accounts that act too fast or too
 * often. Hard-cap per account before we even try the action — a RATE_LIMITED
 * error is dramatically cheaper than a suspended $5 account.
 *
 * How: we log every action to `social_action_log` keyed by account+platform+
 * operation, then check rolling-window counts before the next action.
 */
import { db } from "../db";

export type Platform = "twitter" | "tiktok";

export interface RateLimitPolicy {
  /** Minimum gap between ANY two actions on the same account (ms). */
  minSpacingMs: number;
  /** Per-operation rolling-window caps. */
  windows: Array<{
    operations: string[];       // empty = all operations
    windowMs: number;
    max: number;
  }>;
}

/**
 * Conservative defaults. Rates chosen to stay well under the platforms'
 * observed suspension thresholds. Tune over time as data comes in.
 */
const POLICIES: Record<Platform, RateLimitPolicy> = {
  twitter: {
    minSpacingMs: 5_000,
    windows: [
      { operations: ["post", "reply"], windowMs: 3600_000, max: 20 },
      { operations: ["follow", "unfollow"], windowMs: 3600_000, max: 40 },
      { operations: ["like", "retweet"], windowMs: 3600_000, max: 120 },
    ],
  },
  tiktok: {
    minSpacingMs: 30_000,          // 30s between any two actions
    windows: [
      { operations: ["post"], windowMs: 24 * 3600_000, max: 3 },     // 3 posts / 24h
      { operations: ["follow"], windowMs: 3600_000, max: 20 },        // 20 follows / hour
      { operations: ["like"], windowMs: 3600_000, max: 60 },          // 60 likes / hour
      { operations: ["comment"], windowMs: 3600_000, max: 15 },       // 15 comments / hour
    ],
  },
};

export interface RateLimitResult {
  ok: boolean;
  /** Human-readable reason (only set when ok=false). */
  reason?: string;
  /** Milliseconds until the caller should retry. */
  retry_after_ms?: number;
}

/**
 * Check whether `operation` is allowed right now for the given account.
 * Does NOT record the action — callers must invoke `recordAction()` after the
 * operation actually succeeds, to avoid penalising the account for failures.
 */
export function checkRateLimit(
  accountId: string,
  platform: Platform,
  operation: string
): RateLimitResult {
  const policy = POLICIES[platform];
  if (!policy) return { ok: true };
  const now = Date.now();

  // 1. Absolute minimum spacing across all operations.
  const last = db
    .prepare(
      `SELECT acted_at FROM social_action_log
       WHERE account_id = ? AND platform = ?
       ORDER BY acted_at DESC LIMIT 1`
    )
    .get(accountId, platform) as { acted_at: number } | undefined;

  if (last) {
    const gap = now - last.acted_at;
    if (gap < policy.minSpacingMs) {
      return {
        ok: false,
        reason: `Minimum ${policy.minSpacingMs / 1000}s between actions on this account. Last action ${Math.floor(gap / 1000)}s ago.`,
        retry_after_ms: policy.minSpacingMs - gap,
      };
    }
  }

  // 2. Per-operation window caps.
  for (const w of policy.windows) {
    if (w.operations.length && !w.operations.includes(operation)) continue;
    const since = now - w.windowMs;
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM social_action_log
         WHERE account_id = ? AND platform = ? AND operation = ?
           AND acted_at > ?`
      )
      .get(accountId, platform, operation, since) as { n: number };
    if (row.n >= w.max) {
      return {
        ok: false,
        reason: `Hit ${w.max} ${operation}s in ${Math.round(w.windowMs / 60000)}min. Protective cap — try again later to avoid suspending this account.`,
        retry_after_ms: w.windowMs,
      };
    }
  }

  return { ok: true };
}

export function recordAction(
  accountId: string,
  platform: Platform,
  operation: string
): void {
  db.prepare(
    `INSERT INTO social_action_log (account_id, platform, operation, acted_at)
     VALUES (?, ?, ?, ?)`
  ).run(accountId, platform, operation, Date.now());

  // Opportunistic cleanup: drop rows older than 48h.
  try {
    db.prepare(
      `DELETE FROM social_action_log WHERE acted_at < ?`
    ).run(Date.now() - 48 * 3600_000);
  } catch {}
}

/** Utility: count actions in a rolling window. Useful for client-facing quota APIs. */
export function countActions(
  accountId: string,
  platform: Platform,
  operation: string,
  windowMs: number
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM social_action_log
       WHERE account_id = ? AND platform = ? AND operation = ?
         AND acted_at > ?`
    )
    .get(accountId, platform, operation, Date.now() - windowMs) as { n: number };
  return row.n;
}
