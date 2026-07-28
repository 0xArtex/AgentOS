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
