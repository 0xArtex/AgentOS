/**
 * Aggregate TikTok operation outcomes, read from the job tables.
 *
 * Nothing in the product read those tables before this. That is why five failed
 * operations in June sat unexamined for five weeks, why nobody could say
 * whether the feature had ever worked in production, and why every judgement
 * about which failure mattered most was a guess rather than a measurement.
 *
 * Deliberately counts-only — no captions, no video ids, no account handles, no
 * owner wallets — so the result is safe to serve unauthenticated alongside the
 * proxy-health signal.
 */
import { db } from "../db";

export interface OpHealth {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  error_codes: Record<string, number>;
  /** Undefined when nothing terminal ran — see snapshot(). */
  success_rate_pct?: number;
}

export interface TikTokHealthSnapshot {
  window_hours: number;
  since: string;
  totals: { total: number; succeeded: number; failed: number; pending: number; success_rate_pct?: number };
  operations: Record<string, OpHealth>;
}

/** Terminal states meaning the operation did what it was paid to do. */
const TERMINAL_OK = new Set(["posted", "done"]);

/**
 * A rate is undefined, not zero, when nothing terminal ran in the window.
 * "No data" and "everything failed" are different answers and must not look
 * alike — reporting 0% for an idle window would manufacture an outage.
 */
function successRate(succeeded: number, failed: number): number | undefined {
  const terminal = succeeded + failed;
  return terminal > 0 ? Math.round((succeeded / terminal) * 1000) / 10 : undefined;
}

export function tiktokHealthSnapshot(hours: number): TikTokHealthSnapshot {
  const window_hours = Math.min(Math.max(Math.floor(hours) || 24, 1), 720);
  const since = new Date(Date.now() - window_hours * 3600_000).toISOString();

  const rows: Array<{ op: string; status: string; error_code: string; n: number }> = [];
  const collect = (sql: string) => {
    try {
      rows.push(...(db.prepare(sql).all(since) as any[]));
    } catch {
      /* table may not exist on an older deployment — an absent table is simply no data */
    }
  };
  collect(
    `SELECT 'post' AS op, status, COALESCE(NULLIF(error_code,''),'-') AS error_code, COUNT(*) AS n
       FROM tiktok_post_jobs WHERE created_at > ? GROUP BY status, error_code`,
  );
  collect(
    `SELECT op, status, COALESCE(NULLIF(error_code,''),'-') AS error_code, COUNT(*) AS n
       FROM tiktok_op_jobs WHERE created_at > ? GROUP BY op, status, error_code`,
  );

  const operations: Record<string, OpHealth> = {};
  for (const r of rows) {
    const e = (operations[r.op] ||= { total: 0, succeeded: 0, failed: 0, pending: 0, error_codes: {} });
    e.total += r.n;
    if (TERMINAL_OK.has(r.status)) e.succeeded += r.n;
    else if (r.status === "failed") e.failed += r.n;
    // Anything else is still in flight; counting it as either outcome would
    // misstate the rate in whichever direction happened to be convenient.
    else e.pending += r.n;
    if (r.error_code !== "-") e.error_codes[r.error_code] = (e.error_codes[r.error_code] || 0) + r.n;
  }
  for (const e of Object.values(operations)) e.success_rate_pct = successRate(e.succeeded, e.failed);

  const totals = Object.values(operations).reduce(
    (a, e) => ({
      total: a.total + e.total,
      succeeded: a.succeeded + e.succeeded,
      failed: a.failed + e.failed,
      pending: a.pending + e.pending,
    }),
    { total: 0, succeeded: 0, failed: 0, pending: 0 },
  );

  return {
    window_hours,
    since,
    totals: { ...totals, success_rate_pct: successRate(totals.succeeded, totals.failed) },
    operations,
  };
}
