/**
 * The TikTok account registry.
 *
 * Until this existed, `account_id` was a string the caller made up. Nothing
 * bound an account to a wallet, so any caller could name any account and act on
 * it, and the protective velocity caps keyed on that string reset the moment
 * you changed it. Accounts also lived nowhere the server could see: a
 * server-side login produced a directory on disk and no record at all, so
 * "which accounts do I have, and are they still logged in" had no answer.
 *
 * A row here is the fact the rest of the system checks against. It stores no
 * credentials — for a server-side account the browser profile IS the
 * credential, and it never leaves the box.
 */
import { db } from "../db";
import { hasServerProfile } from "./social-runtime";

export type AccountStatus = "connecting" | "active" | "logged_out" | "restricted" | "dead";

export interface TikTokAccountRow {
  id: string;
  owner: string;
  handle: string | null;
  country: string | null;
  proxy_session_id: string | null;
  tag: string | null;
  status: AccountStatus;
  connected_at: string | null;
  last_seen_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
}

const nowIso = () => new Date().toISOString();

/**
 * Record an account at the start of a login. Idempotent: re-connecting an
 * account keeps its identity and history, so a re-login is a repair rather
 * than a new account.
 *
 * Deliberately does NOT let a second wallet claim an existing account — a
 * re-connect by a different owner is refused, not silently transferred.
 */
export function registerAccount(opts: {
  id: string;
  owner: string;
  country?: string;
  proxySessionId?: string;
  tag?: string;
}): { ok: true; row: TikTokAccountRow } | { ok: false; error: string } {
  const existing = getAccount(opts.id);
  if (existing && existing.owner !== opts.owner) {
    return { ok: false, error: `account ${opts.id} is already registered to a different wallet` };
  }
  if (existing) {
    db.prepare(
      `UPDATE tiktok_accounts
          SET status = 'connecting',
              country = COALESCE(?, country),
              proxy_session_id = COALESCE(?, proxy_session_id),
              tag = COALESCE(?, tag)
        WHERE id = ?`,
    ).run(opts.country ?? null, opts.proxySessionId ?? null, opts.tag ?? null, opts.id);
    return { ok: true, row: getAccount(opts.id)! };
  }
  db.prepare(
    `INSERT INTO tiktok_accounts (id, owner, handle, country, proxy_session_id, tag, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'connecting', ?)`,
  ).run(opts.id, opts.owner, opts.id, opts.country ?? null, opts.proxySessionId ?? null, opts.tag ?? null, nowIso());
  return { ok: true, row: getAccount(opts.id)! };
}

export function getAccount(id: string): TikTokAccountRow | undefined {
  return db.prepare("SELECT * FROM tiktok_accounts WHERE id = ?").get(id) as TikTokAccountRow | undefined;
}

/** A login completed — the profile now holds a real session. */
export function markConnected(id: string): void {
  const at = nowIso();
  db.prepare(
    "UPDATE tiktok_accounts SET status='active', connected_at=?, last_seen_at=?, last_error_code=NULL, last_error_at=NULL WHERE id=?",
  ).run(at, at, id);
}

/**
 * An operation succeeded, so the session demonstrably still works.
 *
 * This clears the last error too. A row here answers "what is true about this
 * account NOW", and an account that just succeeded still wearing an old error
 * code reads as broken — `hours_since_success: 0` next to
 * `last_error_code: UNKNOWN` is a contradiction a reader has to resolve by
 * comparing timestamps. The operation history is kept by the health endpoint,
 * which is where a diagnostic question belongs.
 *
 * A success also revives a `logged_out` account: a working session is direct
 * proof it is not logged out. It deliberately does NOT clear `restricted` —
 * restrictions are feature-scoped (TikTok and X both restrict one capability
 * while leaving the rest alone), so a follow succeeding is no evidence that a
 * block on some other action has lifted. Same rule as `noteFailure`, pointed
 * the other way: only move status on evidence that speaks to it.
 */
export function noteSuccess(id: string): void {
  db.prepare(
    `UPDATE tiktok_accounts
        SET last_seen_at=?,
            last_error_code=NULL,
            last_error_at=NULL,
            status=CASE WHEN status IN ('connecting','logged_out') THEN 'active' ELSE status END
      WHERE id=?`,
  ).run(nowIso(), id);
}

/**
 * An operation failed. The error code is recorded, but the STATUS only moves
 * for codes that actually say something about the account.
 *
 * A page that failed to render says nothing about whether the account is
 * logged in — inferring "logged out" from it is how the old code came to
 * report confident, wrong diagnoses. Only an explicit session or restriction
 * signal changes what we claim about the account.
 */
export function noteFailure(id: string, errorCode?: string): void {
  const code = errorCode || "UNKNOWN";
  const status =
    code === "SESSION_EXPIRED" ? "logged_out"
    : code === "ACCOUNT_RESTRICTED" ? "restricted"
    : null;
  if (status) {
    db.prepare("UPDATE tiktok_accounts SET last_error_code=?, last_error_at=?, status=? WHERE id=?")
      .run(code, nowIso(), status, id);
    return;
  }
  db.prepare("UPDATE tiktok_accounts SET last_error_code=?, last_error_at=? WHERE id=?").run(code, nowIso(), id);
}

export function setTag(id: string, tag: string | null): void {
  db.prepare("UPDATE tiktok_accounts SET tag=? WHERE id=?").run(tag, id);
}

/** Record the real @handle once a login reveals it (registration seeds it to the id). */
export function setHandle(id: string, handle: string): void {
  db.prepare("UPDATE tiktok_accounts SET handle=? WHERE id=?").run(handle, id);
}

/**
 * Move an account to the terminal 'dead' state with a diagnostic code. Used when
 * a pool seed can't establish a session: poolStock counts only 'active', so a
 * dead row is never offered to a buyer, and the code says why the seed failed.
 */
export function markDead(id: string, errorCode?: string): void {
  db.prepare("UPDATE tiktok_accounts SET status='dead', last_error_code=?, last_error_at=? WHERE id=?")
    .run(errorCode || "SEED_FAILED", nowIso(), id);
}

export interface AccountHealth extends TikTokAccountRow {
  /** Whether a browser profile actually exists on this host for the account. */
  profile_present: boolean;
  /** Hours since the last successful operation, or null if never. */
  hours_since_success: number | null;
}

function withHealth(row: TikTokAccountRow): AccountHealth {
  const last = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  return {
    ...row,
    profile_present: hasServerProfile(row.id),
    hours_since_success: Number.isNaN(last) ? null : Math.round(((Date.now() - last) / 3_600_000) * 10) / 10,
  };
}

/** Every account a wallet owns, newest first. Optionally filtered to one tag. */
export function listByOwner(owner: string, tag?: string): AccountHealth[] {
  const rows = tag
    ? db.prepare("SELECT * FROM tiktok_accounts WHERE owner=? AND tag=? ORDER BY created_at DESC").all(owner, tag)
    : db.prepare("SELECT * FROM tiktok_accounts WHERE owner=? ORDER BY created_at DESC").all(owner);
  return (rows as TikTokAccountRow[]).map(withHealth);
}

export type OwnershipVerdict =
  | { allowed: true; registered: boolean }
  | { allowed: false; reason: string };

/**
 * May this caller act on this account?
 *
 * Registered accounts are owner-only — that binding is the entire point.
 * Unregistered ids stay permitted so the older flow keeps working: there, the
 * caller supplies the cookie jar, and holding a valid session is itself the
 * proof. Enforcing ownership on ids nobody has registered would break every
 * existing account without making anything safer.
 */
export function checkOwnership(accountId: string, caller: string | undefined): OwnershipVerdict {
  const row = getAccount(accountId);
  if (!row) return { allowed: true, registered: false };
  if (!caller) {
    return { allowed: false, reason: `account ${accountId} is registered; identify yourself (pay or present a wallet proof) to use it` };
  }
  if (row.owner !== caller) {
    return { allowed: false, reason: `account ${accountId} belongs to another wallet` };
  }
  return { allowed: true, registered: true };
}

/* ─── Deployable pool ──────────────────────────────────────────────────────
   A warmed, server-connected account waiting to be handed to a buyer is just a
   row owned by a reserved sentinel. "Deploying" it is an atomic owner swap — no
   second table, and no credentials to move, because the profile stays on the box
   and IS the credential. This mirrors social_account_pool's poolBuy, adapted to
   the profile-is-the-credential model where the account never leaves the server. */

/**
 * The reserved owner for accounts sitting in the deployable pool. Namespaced with
 * a colon so it can never collide with a real wallet or a `dashboard:<id>`
 * identity — both of which own their accounts through this same column.
 */
export const POOL_OWNER = "palmyr:tiktok-pool";

export interface PoolLeaseResult {
  ok: boolean;
  row?: TikTokAccountRow;
  error?: string;
}

/**
 * Hand the oldest ready pool account to `buyer`, optionally filtered by country.
 * Atomic like poolBuy: pick the oldest eligible row, then flip its owner in the
 * SAME transaction guarded on the sentinel, so two concurrent deploys can never
 * lease the same account (the second UPDATE matches zero rows and loses the race).
 * Only 'active' rows are eligible — a pool account that logged out has no live
 * session to hand over.
 */
export function leaseFromPool(
  buyer: string,
  opts: { country?: string; tag?: string } = {},
): PoolLeaseResult {
  if (!buyer) return { ok: false, error: "buyer identity required" };
  if (buyer === POOL_OWNER) return { ok: false, error: "cannot lease to the pool sentinel" };
  const country = opts.country ? opts.country.toUpperCase() : null;
  const lease = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM tiktok_accounts
          WHERE owner = ? AND status = 'active'
            AND (? IS NULL OR UPPER(country) = ?)
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get(POOL_OWNER, country, country) as { id: string } | undefined;
    if (!row) return null;
    const res = db
      .prepare(
        `UPDATE tiktok_accounts
            SET owner = ?, tag = COALESCE(?, tag), connected_at = COALESCE(connected_at, ?)
          WHERE id = ? AND owner = ? AND status = 'active'`,
      )
      .run(buyer, opts.tag ?? null, nowIso(), row.id, POOL_OWNER);
    if (res.changes !== 1) return null; // lost the race to a concurrent deploy
    return row.id;
  });
  const id = lease();
  if (!id) {
    return {
      ok: false,
      error: country ? `no ready pool accounts for country=${country}` : "no ready pool accounts",
    };
  }
  return { ok: true, row: getAccount(id)! };
}

/**
 * Register a fresh row destined for the pool (owner = sentinel). The seed flow
 * calls this before starting the QR connect, so the account is pool-owned from
 * the first moment rather than producing an orphan directory nothing can attribute.
 */
export function registerPoolAccount(opts: {
  id: string;
  country?: string;
  proxySessionId?: string;
  tag?: string;
}): { ok: true; row: TikTokAccountRow } | { ok: false; error: string } {
  return registerAccount({
    id: opts.id,
    owner: POOL_OWNER,
    country: opts.country,
    proxySessionId: opts.proxySessionId,
    tag: opts.tag,
  });
}

export interface PoolStock {
  total: number;
  by_country: Record<string, number>;
}

/**
 * Ready-to-deploy stock, grouped by country. Powers both the no-stock hint on a
 * failed deploy ("in stock now: US, BR") and the storefront's availability view.
 */
export function poolStock(): PoolStock {
  // Country is grouped upper-cased so the keys line up with the lease filter
  // (which matches on UPPER(country)) and the storefront's flag/name lookups,
  // regardless of the case a seed was stored in.
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(UPPER(country), ''), '?') AS country, COUNT(*) AS n
         FROM tiktok_accounts
        WHERE owner = ? AND status = 'active'
        GROUP BY COALESCE(NULLIF(UPPER(country), ''), '?')`,
    )
    .all(POOL_OWNER) as Array<{ country: string; n: number }>;
  const by_country: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    by_country[r.country] = r.n;
    total += r.n;
  }
  return { total, by_country };
}
