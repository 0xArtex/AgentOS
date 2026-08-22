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
import { encrypt, decrypt } from "./pool-crypto";

export type AccountStatus = "connecting" | "active" | "logged_out" | "restricted" | "dead";

// Self-contained schema guard for the handover credentials column. A server
// account's session lives in its browser profile (profile-is-the-credential),
// but for the credential-HANDOVER model the seeder also stores the raw login so
// a buyer can be handed it on deploy and sign in on their own device. Nullable,
// encrypted at rest (AES-GCM via POOL_ENCRYPTION_KEY). Guarded + idempotent,
// mirroring social-pool's rest_id backfill.
ensureCredentialsColumn();
function ensureCredentialsColumn(): void {
  try {
    const cols = db.prepare("PRAGMA table_info(tiktok_accounts)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "credentials_encrypted")) {
      db.exec("ALTER TABLE tiktok_accounts ADD COLUMN credentials_encrypted TEXT");
    }
    // revealed_at = the moment the owner took the raw login. It's the
    // commitment gate: an UNrevealed account is still "sealed" (Palmyr holds
    // the session, the login never left the box) so it can be refunded or
    // resold clean; once revealed the owner has the keys, so it becomes
    // non-refundable and non-resellable. Nullable; set once, never cleared.
    if (!cols.some((c) => c.name === "revealed_at")) {
      db.exec("ALTER TABLE tiktok_accounts ADD COLUMN revealed_at TEXT");
    }
    // Resale marketplace: an owner can list an UNrevealed account for sale.
    // list_price_usdc non-null = for sale at that price; NULL = not listed.
    if (!cols.some((c) => c.name === "list_price_usdc")) {
      db.exec("ALTER TABLE tiktok_accounts ADD COLUMN list_price_usdc REAL");
    }
    if (!cols.some((c) => c.name === "listed_at")) {
      db.exec("ALTER TABLE tiktok_accounts ADD COLUMN listed_at TEXT");
    }
    // Purchase provenance for POOL sales (deploy), so an unused/unrevealed
    // account can be auto-refunded and reclaimed. Set at deploy, cleared on
    // refund-reclaim AND on resale (so a resold account can't be refunded
    // against Palmyr's treasury — the seller already holds the money).
    for (const col of ["bought_at TEXT", "bought_amount_usdc REAL", "bought_payment_sig TEXT", "bought_chain TEXT"]) {
      const name = col.split(" ")[0];
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE tiktok_accounts ADD COLUMN ${col}`);
    }
  } catch (e: any) {
    console.warn("[tiktok-accounts] could not ensure account columns:", e?.message || e);
  }
}

/** Handover credentials for a TikTok account (accsmarket shape). */
export interface TikTokCredentials {
  login: string;
  password: string;
  email?: string;
  email_password?: string;
}

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
  /** When the owner revealed the raw credentials (the commitment gate). Null = still sealed. */
  revealed_at: string | null;
  /** Resale price if the owner has listed it on the marketplace; null = not for sale. */
  list_price_usdc: number | null;
  /** When it was listed for sale; null = not listed. */
  listed_at: string | null;
  /** Purchase provenance for a POOL sale (deploy); null = not a refundable pool purchase. */
  bought_at: string | null;
  bought_amount_usdc: number | null;
  bought_payment_sig: string | null;
  bought_chain: string | null;
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

/**
 * Store (or replace) the handover credentials for an account, encrypted at rest.
 * Separate from registration so the QR-seed flow can attach creds the seeder
 * already holds without the credentials ever touching a login attempt (TikTok's
 * automated login is blocked — we never type them; the buyer does).
 */
export function setCredentials(id: string, creds: TikTokCredentials): void {
  db.prepare("UPDATE tiktok_accounts SET credentials_encrypted=? WHERE id=?")
    .run(encrypt(JSON.stringify(creds)), id);
}

/** Decrypt the stored handover credentials, or null if none were seeded. */
export function getCredentials(id: string): TikTokCredentials | null {
  const row = db.prepare("SELECT credentials_encrypted FROM tiktok_accounts WHERE id=?").get(id) as
    | { credentials_encrypted: string | null }
    | undefined;
  if (!row || !row.credentials_encrypted) return null;
  try {
    return JSON.parse(decrypt(row.credentials_encrypted)) as TikTokCredentials;
  } catch {
    return null;
  }
}

/** Whether handover credentials are stored (without decrypting them). */
export function hasCredentials(id: string): boolean {
  const row = db.prepare("SELECT credentials_encrypted FROM tiktok_accounts WHERE id=?").get(id) as
    | { credentials_encrypted: string | null }
    | undefined;
  return Boolean(row && row.credentials_encrypted);
}

/**
 * Mark an account revealed — the owner has taken the raw login. Set once and
 * never cleared (COALESCE keeps the first reveal time), because the point is
 * irreversible: the moment the login is seen, the account can no longer be
 * refunded or resold clean.
 */
export function markRevealed(id: string): void {
  db.prepare("UPDATE tiktok_accounts SET revealed_at = COALESCE(revealed_at, ?) WHERE id=?")
    .run(nowIso(), id);
}

/** Whether the owner has revealed the credentials (→ non-refundable, non-resellable). */
export function isRevealed(id: string): boolean {
  const row = db.prepare("SELECT revealed_at FROM tiktok_accounts WHERE id=?").get(id) as
    | { revealed_at: string | null }
    | undefined;
  return Boolean(row && row.revealed_at);
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

/* ─── Resale marketplace ────────────────────────────────────────────────────
   An owner can list an account they hold for sale. Only UNREVEALED, active
   accounts are listable: revealing takes the keys (a clean resale can't be
   guaranteed), and a dead session has nothing live to hand over. A buy is an
   atomic owner swap seller→buyer (mirrors leaseFromPool) — the server session
   transfers with the row, so the buyer inherits it logged-in. Pool-sentinel
   stock is sold via deploy, not here, so the sentinel can't list. */

export interface ListResult {
  ok: boolean;
  error?: string;
  row?: TikTokAccountRow;
}

/** List an account you own for sale. Owner-only; unrevealed + active only. */
export function listForSale(id: string, owner: string, priceUsdc: number): ListResult {
  const row = getAccount(id);
  if (!row) return { ok: false, error: `account ${id} not found` };
  if (row.owner !== owner) return { ok: false, error: `account ${id} belongs to another wallet` };
  if (owner === POOL_OWNER) return { ok: false, error: "pool stock is sold via deploy, not the resale market" };
  if (row.revealed_at) return { ok: false, error: "this account's credentials were revealed — a revealed account can't be resold" };
  if (row.status !== "active") return { ok: false, error: `account is '${row.status}', not active — only a live session can be resold` };
  if (typeof priceUsdc !== "number" || !Number.isFinite(priceUsdc) || priceUsdc <= 0) {
    return { ok: false, error: "price_usdc must be a positive number" };
  }
  db.prepare("UPDATE tiktok_accounts SET list_price_usdc=?, listed_at=? WHERE id=? AND owner=?")
    .run(priceUsdc, nowIso(), id, owner);
  return { ok: true, row: getAccount(id)! };
}

/** Remove your own listing. Owner-only. Idempotent. */
export function unlist(id: string, owner: string): ListResult {
  const row = getAccount(id);
  if (!row) return { ok: false, error: `account ${id} not found` };
  if (row.owner !== owner) return { ok: false, error: `account ${id} belongs to another wallet` };
  db.prepare("UPDATE tiktok_accounts SET list_price_usdc=NULL, listed_at=NULL WHERE id=? AND owner=?")
    .run(id, owner);
  return { ok: true, row: getAccount(id)! };
}

export interface MarketListing {
  account_id: string;
  country: string | null;
  price_usdc: number;
  listed_at: string | null;
}

/** Public browse of for-sale accounts (no owner, no handle, no credentials). */
export function marketListings(opts: { country?: string } = {}): MarketListing[] {
  const country = opts.country ? opts.country.toUpperCase() : null;
  const rows = db
    .prepare(
      `SELECT id, country, list_price_usdc, listed_at FROM tiktok_accounts
        WHERE list_price_usdc IS NOT NULL AND status = 'active'
          AND (? IS NULL OR UPPER(country) = ?)
        ORDER BY list_price_usdc ASC, listed_at ASC`,
    )
    .all(country, country) as Array<{ id: string; country: string | null; list_price_usdc: number; listed_at: string | null }>;
  return rows.map((r) => ({ account_id: r.id, country: r.country, price_usdc: r.list_price_usdc, listed_at: r.listed_at }));
}

export interface MarketBuyResult {
  ok: boolean;
  error?: string;
  /** Set when the buyer tried to buy their own listing — a 4xx, not a race. */
  ownListing?: boolean;
  row?: TikTokAccountRow;
  seller?: string;
  price_usdc?: number;
}

/**
 * Atomically buy a specific listed account: swap owner seller→buyer, clear the
 * listing, in one transaction guarded on the seller still owning it (so two
 * concurrent buys can't both win). Refuses a self-purchase. The caller pays the
 * seller (price − fee) after this returns ok.
 */
export function buyFromMarket(buyer: string, id: string): MarketBuyResult {
  if (!buyer) return { ok: false, error: "buyer identity required" };
  const pre = getAccount(id);
  if (!pre || pre.list_price_usdc == null || pre.status !== "active") {
    return { ok: false, error: `account ${id} is not for sale` };
  }
  if (pre.owner === buyer) return { ok: false, ownListing: true, error: "you can't buy your own listing" };
  const seller = pre.owner;
  const price = pre.list_price_usdc;
  const swap = db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE tiktok_accounts
            SET owner=?, list_price_usdc=NULL, listed_at=NULL,
                bought_at=NULL, bought_amount_usdc=NULL, bought_payment_sig=NULL, bought_chain=NULL
          WHERE id=? AND owner=? AND list_price_usdc IS NOT NULL AND status='active'`,
      )
      .run(buyer, id, seller);
    return res.changes === 1;
  });
  if (!swap()) return { ok: false, error: "listing was just taken or withdrawn — try another" };
  return { ok: true, row: getAccount(id)!, seller, price_usdc: price };
}

/* ─── Refund (pool sales only) ──────────────────────────────────────────────
   A buyer can return an account they bought from Palmyr's pool (deploy) while
   it's still sealed (unrevealed), unused, and within the window. Provenance is
   recorded at deploy and CLEARED on resale + reclaim, so only the current
   pool-deploy owner can refund — a resold account (seller already paid) can't
   be refunded against the treasury. */

/** Record a pool purchase on the row so it can be refunded + reclaimed. */
export function recordPurchase(
  id: string,
  opts: { amountUsdc: number; paymentSig?: string | null; chain?: string | null },
): void {
  db.prepare(
    "UPDATE tiktok_accounts SET bought_at=?, bought_amount_usdc=?, bought_payment_sig=?, bought_chain=? WHERE id=?",
  ).run(nowIso(), opts.amountUsdc, opts.paymentSig ?? null, opts.chain ?? null, id);
}

/**
 * Has the buyer used the account (a value op) since they bought it? Excludes the
 * deploy-time rebrand (profile/avatar) and read-only analytics — only real usage
 * (follow/like/delete/post) counts. Tables may not exist in a bare unit context;
 * treat a missing table as "not used".
 */
export function hasBuyerUsedSince(id: string, sinceIso: string): boolean {
  try {
    const op = db
      .prepare(
        "SELECT 1 FROM tiktok_op_jobs WHERE account_id=? AND created_at > ? AND op IN ('follow','like','delete') LIMIT 1",
      )
      .get(id, sinceIso);
    if (op) return true;
  } catch { /* table not present in this context */ }
  try {
    const post = db
      .prepare("SELECT 1 FROM tiktok_post_jobs WHERE account_id=? AND created_at > ? LIMIT 1")
      .get(id, sinceIso);
    if (post) return true;
  } catch { /* table not present */ }
  return false;
}

/** Return a refunded/returned account to the deployable pool and wipe buyer state. */
export function reclaimToPool(id: string): void {
  db.prepare(
    `UPDATE tiktok_accounts
        SET owner=?, list_price_usdc=NULL, listed_at=NULL,
            bought_at=NULL, bought_amount_usdc=NULL, bought_payment_sig=NULL, bought_chain=NULL
      WHERE id=?`,
  ).run(POOL_OWNER, id);
}
