/**
 * Server-side pool of pre-seasoned social accounts.
 *
 * Admin seeds the pool with `poolAdd()`. Each entry gets a unique
 * `proxy_session_id` (UUID) generated at seed time, pinning the IPRoyal
 * sticky residential IP for the account's lifetime. The admin's login test
 * runs through that session, captures cookies, and stores everything
 * encrypted at rest.
 *
 * Buyers call `poolBuy()`. The server atomically reserves the oldest
 * `ready` row matching their filters, decrypts the credentials + cookies,
 * and hands them off to the buyer's CLI. The buyer's local vault stores
 * the `proxy_session_id`; every future op pins the same IP.
 *
 * Pool encryption key is a 32-byte hex env var (`POOL_ENCRYPTION_KEY`).
 * Without it, pool routes refuse to boot.
 */
import { db } from "../db";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "crypto";
import { loginTwitter } from "./social-login";
import { getUserInfo } from "./twitter-api";

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

function getKey(): Buffer {
  const hex = process.env.POOL_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "POOL_ENCRYPTION_KEY must be set to a 64-char hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString("hex"),
    ciphertext: ct.toString("hex"),
    tag: tag.toString("hex"),
  };
  return JSON.stringify(blob);
}

function decrypt(stored: string): string {
  const key = getKey();
  const blob = JSON.parse(stored) as EncryptedBlob;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  let pt = decipher.update(blob.ciphertext, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}

export interface PoolCredentials {
  login: string;
  password: string;
  email?: string;
  email_password?: string;
  totp_seed?: string;
  auth_token?: string;
  ct0?: string;
  profile_url?: string;
}

export interface PoolAddRequest {
  platform: "twitter";
  username: string;
  credentials: PoolCredentials;
  country?: string;
  age_category?: string;
  acquired_cost_usdc?: number;
  sale_price_usdc: number;
  notes?: string;
}

export interface PoolAddResult {
  success: boolean;
  id?: string;
  proxy_session_id?: string;
  cookies_captured?: number;
  error?: string;
  login_error_code?: string;
  /** Country resolved by twitterapi.io profile lookup (may be null when API key is unset or location is ambiguous). */
  detected_country?: string | null;
  /** Free-text location string from X as returned by twitterapi.io. Stored for admin context. */
  detected_location?: string | null;
  /** Raw "Connected via" string — e.g. "United Kingdom Android App". */
  detected_source?: string | null;
  /** ISO alpha-2 parsed out of source — country the account was registered from. */
  detected_registered_country?: string | null;
  /** 'android' | 'ios' | 'web' — platform the account was registered on. */
  detected_registered_platform?: string | null;
  /** Number of @handle renames recorded by X. 0 = never renamed. */
  detected_username_change_count?: number | null;
  /** about_profile.account_based_in free-text — preferred over location_raw for country derivation. */
  detected_account_based_in?: string | null;
  /** about_profile.location_accurate flag. */
  detected_location_accurate?: boolean | null;
  /** about_profile.affiliate_username (org handle), if any. */
  detected_affiliate_username?: string | null;
  /** Final country saved to the row — admin override wins over detection. */
  country?: string | null;
  /** Present when admin-provided country disagrees with detection; non-fatal but flagged for review. */
  country_mismatch?: { admin: string; detected: string };
}

export async function poolAdd(req: PoolAddRequest): Promise<PoolAddResult> {
  if (req.platform !== "twitter") {
    return { success: false, error: "The shared account pool is twitter-only right now; TikTok accounts are managed via the local CLI (`palmyr tiktok connect`/`list`)." };
  }
  if (!req.username || !req.credentials?.password) {
    return { success: false, error: "username and credentials.password are required" };
  }
  if (typeof req.sale_price_usdc !== "number" || req.sale_price_usdc <= 0) {
    return { success: false, error: "sale_price_usdc must be a positive number" };
  }

  const id = randomUUID().replace(/-/g, "");
  const proxySessionId = id; // use the hex id as the IPRoyal session key

  // Season the account: run a real login against X through the new sticky
  // session, so X sees the seeded residential IP first and cookies are
  // pre-warmed for the eventual buyer.
  const loginResult = await loginTwitter({
    account_id: id,
    proxy_session_id: proxySessionId,
    login: req.credentials.login,
    password: req.credentials.password,
    totp_seed: req.credentials.totp_seed,
    auth_token: req.credentials.auth_token,
    ct0: req.credentials.ct0,
  });

  if (!loginResult.success) {
    return {
      success: false,
      error: `Seed login failed: ${loginResult.error || "unknown"}`,
      login_error_code: loginResult.error_code,
    };
  }

  const cookies = loginResult.cookies || [];

  // Profile detection via twitterapi.io — runs AFTER the seed login confirms
  // the account is alive. Country, source, rename history, and the richer
  // about_profile fields all come from one round-trip. Returns null when
  // TWITTER_API_IO_KEY is unset or the API is unreachable; the admin's
  // --country flag remains the country fallback, other dimensions stay
  // NULL and rows seeded under that path simply won't match `--source` or
  // `--max-renames` filtered buys.
  let detectedCountry: string | null = null;
  let detectedLocation: string | null = null;
  let detectedSource: string | null = null;
  let detectedRegisteredCountry: string | null = null;
  let detectedRegisteredPlatform: string | null = null;
  let detectedChanges: number | null = null;
  let detectedAccountBasedIn: string | null = null;
  let detectedLocationAccurate: boolean | null = null;
  let detectedAffiliate: string | null = null;
  try {
    const info = await getUserInfo(req.username);
    if (info) {
      detectedCountry = info.country;
      detectedLocation = info.location_raw;
      detectedSource = info.source;
      detectedRegisteredCountry = info.registered_country;
      detectedRegisteredPlatform = info.registered_platform;
      detectedChanges = info.username_change_count;
      detectedAccountBasedIn = info.account_based_in;
      detectedLocationAccurate = info.location_accurate;
      detectedAffiliate = info.affiliate_username;
    }
  } catch (e: any) {
    console.warn(`[pool] profile detection threw for @${req.username}:`, e?.message || e);
  }

  const adminCountry = req.country ? req.country.toUpperCase() : null;
  let finalCountry: string | null = adminCountry || detectedCountry;
  let mismatch: { admin: string; detected: string } | undefined;
  if (adminCountry && detectedCountry && adminCountry !== detectedCountry) {
    mismatch = { admin: adminCountry, detected: detectedCountry };
    finalCountry = adminCountry; // explicit admin override wins
  }

  const credsBlob = encrypt(JSON.stringify(req.credentials));
  const cookiesBlob = encrypt(JSON.stringify(cookies));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO social_account_pool (
      id, platform, username, country, age_category,
      proxy_session_id, credentials_encrypted, cookies_encrypted,
      acquired_cost_usdc, sale_price_usdc, status, created_at, tested_at, notes,
      detected_location,
      source, registered_country, registered_platform,
      username_change_count, account_based_in, location_accurate, affiliate_username
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.platform,
    req.username,
    finalCountry,
    req.age_category || null,
    proxySessionId,
    credsBlob,
    cookiesBlob,
    req.acquired_cost_usdc ?? null,
    req.sale_price_usdc,
    now,
    now,
    req.notes || null,
    detectedLocation,
    detectedSource,
    detectedRegisteredCountry,
    detectedRegisteredPlatform,
    detectedChanges,
    detectedAccountBasedIn,
    detectedLocationAccurate == null ? null : (detectedLocationAccurate ? 1 : 0),
    detectedAffiliate,
  );

  return {
    success: true,
    id,
    proxy_session_id: proxySessionId,
    cookies_captured: cookies.length,
    detected_country: detectedCountry,
    detected_location: detectedLocation,
    detected_source: detectedSource,
    detected_registered_country: detectedRegisteredCountry,
    detected_registered_platform: detectedRegisteredPlatform,
    detected_username_change_count: detectedChanges,
    detected_account_based_in: detectedAccountBasedIn,
    detected_location_accurate: detectedLocationAccurate,
    detected_affiliate_username: detectedAffiliate,
    country: finalCountry,
    ...(mismatch ? { country_mismatch: mismatch } : {}),
  };
}

export interface PoolBuyRequest {
  platform: "twitter";
  country?: string;
  age_category?: string;
  /**
   * Registration source filter — exact (lowercased) match against the
   * raw `source` column. The raw value is X's full "Connected via" string
   * (e.g. "united kingdom android app"). Most callers should use the
   * cleaner `registered_country` + `registered_platform` filters below
   * instead of trying to match the full string; this flag is kept for
   * power-user exact filtering and source_multiplier-based pricing.
   */
  source?: string;
  /**
   * ISO alpha-2 country code the account was registered FROM (parsed from
   * the X "Connected via" string). Distinct from `country`, which is X's
   * `account_based_in` residency signal. They can differ — e.g. a user
   * physically in BR with a UK-registered Twitter account.
   */
  registered_country?: string;
  /**
   * 'android' | 'ios' | 'web' — platform the account was registered on.
   */
  registered_platform?: "android" | "ios" | "web";
  /**
   * Cap on username_change_count. e.g. `max_username_changes: 0` selects
   * accounts that have never been renamed. Rows seeded before this feature
   * have username_change_count=NULL and won't match any --max-renames buy
   * (NULL fails the `<=` comparison).
   */
  max_username_changes?: number;
  buyer_wallet: string;
  /**
   * x402 payment provenance — captured at buy time so the dispute service can
   * refund the original payer on the original chain when a same-country
   * replacement isn't available. Omit during legacy code paths that don't
   * have payment context (the dispute service degrades to admin_review when
   * these columns are NULL).
   */
  payment?: {
    signature: string;
    chain: "solana" | "base";
    amount_usdc: number;
  };
}

export interface PoolBuyResult {
  success: boolean;
  account?: {
    id: string;
    platform: string;
    username: string;
    country: string | null;
    age_category: string | null;
    source: string | null;
    registered_country: string | null;
    registered_platform: string | null;
    username_change_count: number | null;
    account_based_in: string | null;
    proxy_session_id: string;
    credentials: PoolCredentials;
    cookies: any[];
  };
  error?: string;
}

export function poolBuy(req: PoolBuyRequest): PoolBuyResult {
  if (req.platform !== "twitter") {
    return { success: false, error: "The shared account pool is twitter-only right now; TikTok accounts are managed via the local CLI (`palmyr tiktok connect`/`list`)." };
  }
  if (!req.buyer_wallet) {
    return { success: false, error: "buyer_wallet is required" };
  }

  // Atomically reserve: find the oldest matching 'ready' row and flip it.
  // Filters that are undefined skip via the `? IS NULL` short-circuit. For
  // source and max_username_changes, NULL on the row means "unknown" — those
  // rows DON'T match when a filter is specified (the explicit comparison
  // fails on NULL), which is the correct behavior: an agent asking for
  // `--source web` shouldn't get an unverified row.
  const sourceFilter = req.source ? req.source.toLowerCase() : null;
  const regCountryFilter = req.registered_country ? req.registered_country.toUpperCase() : null;
  const regPlatformFilter = req.registered_platform ? req.registered_platform.toLowerCase() : null;
  const maxChanges = typeof req.max_username_changes === "number" ? req.max_username_changes : null;
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM social_account_pool
         WHERE platform = ? AND status = 'ready'
           AND (? IS NULL OR country = ?)
           AND (? IS NULL OR age_category = ?)
           AND (? IS NULL OR source = ?)
           AND (? IS NULL OR registered_country = ?)
           AND (? IS NULL OR registered_platform = ?)
           AND (? IS NULL OR username_change_count <= ?)
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(
        req.platform,
        req.country || null,
        req.country || null,
        req.age_category || null,
        req.age_category || null,
        sourceFilter,
        sourceFilter,
        regCountryFilter,
        regCountryFilter,
        regPlatformFilter,
        regPlatformFilter,
        maxChanges,
        maxChanges,
      ) as { id: string } | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE social_account_pool
         SET status='sold', sold_to_wallet=?, sold_at=?,
             payment_signature=?, payment_chain=?, paid_amount_usdc=?
         WHERE id=? AND status='ready'`
      )
      .run(
        req.buyer_wallet,
        now,
        req.payment?.signature ?? null,
        req.payment?.chain ?? null,
        req.payment?.amount_usdc ?? null,
        row.id,
      );
    if (result.changes !== 1) return null; // Lost the race
    return row.id;
  });

  const reservedId = tx();
  if (!reservedId) {
    return {
      success: false,
      error:
        `No matching accounts in pool` +
        (req.country ? ` for country=${req.country}` : "") +
        (req.age_category ? `, age=${req.age_category}` : "") +
        (req.source ? `, source=${req.source}` : "") +
        (req.registered_country ? `, registered_country=${req.registered_country}` : "") +
        (req.registered_platform ? `, platform=${req.registered_platform}` : "") +
        (typeof req.max_username_changes === "number" ? `, max_renames=${req.max_username_changes}` : ""),
    };
  }

  const full = db
    .prepare(
      `SELECT * FROM social_account_pool WHERE id = ?`
    )
    .get(reservedId) as any;

  const credentials = JSON.parse(decrypt(full.credentials_encrypted)) as PoolCredentials;
  const cookies = full.cookies_encrypted ? JSON.parse(decrypt(full.cookies_encrypted)) : [];

  return {
    success: true,
    account: {
      id: full.id,
      platform: full.platform,
      username: full.username,
      country: full.country,
      age_category: full.age_category,
      source: full.source ?? null,
      registered_country: full.registered_country ?? null,
      registered_platform: full.registered_platform ?? null,
      username_change_count: full.username_change_count ?? null,
      account_based_in: full.account_based_in ?? null,
      proxy_session_id: full.proxy_session_id,
      credentials,
      cookies,
    },
  };
}

export interface PoolStatusResult {
  total: number;
  ready: number;
  sold: number;
  dead: number;
  by_country: Record<string, { ready: number; sold: number }>;
  by_source: Record<string, { ready: number; sold: number }>;
  by_registered_country: Record<string, { ready: number; sold: number }>;
  by_registered_platform: Record<string, { ready: number; sold: number }>;
  by_username_changes: { never_renamed: { ready: number; sold: number }; renamed: { ready: number; sold: number }; unknown: { ready: number; sold: number } };
  recent_sales: Array<{ username: string; country: string | null; source: string | null; sold_to_wallet: string; sold_at: string }>;
}

export function poolStatus(): PoolStatusResult {
  const totals = db
    .prepare(
      `SELECT status, COUNT(*) as n FROM social_account_pool GROUP BY status`
    )
    .all() as Array<{ status: string; n: number }>;
  const counts = { ready: 0, sold: 0, dead: 0 };
  for (const r of totals) (counts as any)[r.status] = r.n;

  const byCountryRows = db
    .prepare(
      `SELECT country, status, COUNT(*) as n
       FROM social_account_pool
       WHERE status IN ('ready','sold')
       GROUP BY country, status`
    )
    .all() as Array<{ country: string | null; status: string; n: number }>;
  const by_country: Record<string, { ready: number; sold: number }> = {};
  for (const r of byCountryRows) {
    const k = r.country || "?";
    if (!by_country[k]) by_country[k] = { ready: 0, sold: 0 };
    (by_country[k] as any)[r.status] = r.n;
  }

  const bySourceRows = db
    .prepare(
      `SELECT source, status, COUNT(*) as n
       FROM social_account_pool
       WHERE status IN ('ready','sold')
       GROUP BY source, status`
    )
    .all() as Array<{ source: string | null; status: string; n: number }>;
  const by_source: Record<string, { ready: number; sold: number }> = {};
  for (const r of bySourceRows) {
    const k = r.source || "?";
    if (!by_source[k]) by_source[k] = { ready: 0, sold: 0 };
    (by_source[k] as any)[r.status] = r.n;
  }

  const byRegCountryRows = db
    .prepare(
      `SELECT registered_country, status, COUNT(*) as n
       FROM social_account_pool
       WHERE status IN ('ready','sold')
       GROUP BY registered_country, status`
    )
    .all() as Array<{ registered_country: string | null; status: string; n: number }>;
  const by_registered_country: Record<string, { ready: number; sold: number }> = {};
  for (const r of byRegCountryRows) {
    const k = r.registered_country || "?";
    if (!by_registered_country[k]) by_registered_country[k] = { ready: 0, sold: 0 };
    (by_registered_country[k] as any)[r.status] = r.n;
  }

  const byRegPlatformRows = db
    .prepare(
      `SELECT registered_platform, status, COUNT(*) as n
       FROM social_account_pool
       WHERE status IN ('ready','sold')
       GROUP BY registered_platform, status`
    )
    .all() as Array<{ registered_platform: string | null; status: string; n: number }>;
  const by_registered_platform: Record<string, { ready: number; sold: number }> = {};
  for (const r of byRegPlatformRows) {
    const k = r.registered_platform || "?";
    if (!by_registered_platform[k]) by_registered_platform[k] = { ready: 0, sold: 0 };
    (by_registered_platform[k] as any)[r.status] = r.n;
  }

  const byChangesRows = db
    .prepare(
      `SELECT
         CASE
           WHEN username_change_count IS NULL THEN 'unknown'
           WHEN username_change_count = 0 THEN 'never_renamed'
           ELSE 'renamed'
         END AS bucket,
         status,
         COUNT(*) as n
       FROM social_account_pool
       WHERE status IN ('ready','sold')
       GROUP BY bucket, status`
    )
    .all() as Array<{ bucket: string; status: string; n: number }>;
  const by_username_changes = {
    never_renamed: { ready: 0, sold: 0 },
    renamed: { ready: 0, sold: 0 },
    unknown: { ready: 0, sold: 0 },
  };
  for (const r of byChangesRows) {
    (by_username_changes as any)[r.bucket][r.status] = r.n;
  }

  const recent_sales = (db
    .prepare(
      `SELECT username, country, source, sold_to_wallet, sold_at
       FROM social_account_pool
       WHERE status='sold'
       ORDER BY sold_at DESC
       LIMIT 10`
    )
    .all() as any[]).map((r) => ({
    username: r.username,
    country: r.country,
    source: r.source,
    sold_to_wallet: r.sold_to_wallet,
    sold_at: r.sold_at,
  }));

  return {
    total: counts.ready + counts.sold + counts.dead,
    ready: counts.ready,
    sold: counts.sold,
    dead: counts.dead,
    by_country,
    by_source,
    by_registered_country,
    by_registered_platform,
    by_username_changes,
    recent_sales,
  };
}

/** Mark an account as dead (failed login, banned, etc.) — admin only. */
export function poolMarkDead(id: string, reason: string): boolean {
  const result = db
    .prepare(
      `UPDATE social_account_pool SET status='dead', notes=? WHERE id=?`
    )
    .run(reason, id);
  return result.changes === 1;
}

/* ─── Sharing for pool-bought accounts ─────────────────────────────────
   Once a row is `sold` to a wallet, the buyer can share read+use access
   with another wallet via `shared_with`. Mirrors what x_accounts and
   social_registered_accounts already support. Owner-only writes; reads
   honour either side. */

function parseSharedWith(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(w => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** True if `wallet` is the owner or in the shared_with list. */
export function poolCanAccess(
  row: { sold_to_wallet: string | null; shared_with: string | null },
  wallet: string
): boolean {
  if (!wallet) return false;
  if (row.sold_to_wallet === wallet) return true;
  return parseSharedWith(row.shared_with).includes(wallet);
}

export interface ClaimablePoolAccount {
  id: string;
  username: string;
  platform: string;
  country: string | null;
  proxy_session_id: string;
  access: "owner" | "shared";
  credentials: PoolCredentials;
  cookies: any[];
}

/**
 * Pool accounts the wallet owns or has shared access to, with decrypted
 * credentials + cookies. Used by `palmyr twitter claim` / `list` to
 * surface pool-bought accounts post-share-or-transfer.
 */
export function poolAccountsAccessibleBy(wallet: string, platform: string = "twitter"): ClaimablePoolAccount[] {
  const rows = db
    .prepare(
      `SELECT id, platform, username, country, proxy_session_id,
              credentials_encrypted, cookies_encrypted, sold_to_wallet, shared_with, status
       FROM social_account_pool
       WHERE platform = ?
         AND status = 'sold'
         AND (sold_to_wallet = ? OR shared_with LIKE ?)`
    )
    .all(platform, wallet, `%${wallet}%`) as Array<{
      id: string;
      platform: string;
      username: string;
      country: string | null;
      proxy_session_id: string;
      credentials_encrypted: string;
      cookies_encrypted: string | null;
      sold_to_wallet: string | null;
      shared_with: string | null;
      status: string;
    }>;

  return rows
    .filter(r => poolCanAccess(r, wallet))
    .map(r => {
      let creds: PoolCredentials;
      let cookies: any[] = [];
      try { creds = JSON.parse(decrypt(r.credentials_encrypted)) as PoolCredentials; }
      catch { creds = { login: "", password: "" }; }
      if (r.cookies_encrypted) {
        try { cookies = JSON.parse(decrypt(r.cookies_encrypted)) as any[]; } catch {}
      }
      return {
        id: r.id,
        username: r.username,
        platform: r.platform,
        country: r.country,
        proxy_session_id: r.proxy_session_id,
        access: r.sold_to_wallet === wallet ? "owner" : "shared",
        credentials: creds,
        cookies,
      } as ClaimablePoolAccount;
    });
}

/**
 * Grant `withWallet` shared access. Idempotent. Owner-only — caller's
 * wallet must equal sold_to_wallet. Returns the new shared_with array
 * or null if the row doesn't exist / isn't owned by ownerWallet / is
 * not in 'sold' status.
 */
export function poolShare(id: string, ownerWallet: string, withWallet: string): string[] | null {
  const row = db.prepare(
    `SELECT sold_to_wallet, shared_with FROM social_account_pool
     WHERE id = ? AND sold_to_wallet = ? AND status = 'sold'`
  ).get(id, ownerWallet) as { sold_to_wallet: string; shared_with: string | null } | undefined;
  if (!row) return null;
  const current = parseSharedWith(row.shared_with);
  if (current.includes(withWallet) || withWallet === ownerWallet) return current;
  const next = [...current, withWallet];
  db.prepare(`UPDATE social_account_pool SET shared_with = ? WHERE id = ?`)
    .run(JSON.stringify(next), id);
  return next;
}

/** Remove a wallet from shared_with. Idempotent. Owner-only. */
export function poolUnshare(id: string, ownerWallet: string, withWallet: string): string[] | null {
  const row = db.prepare(
    `SELECT sold_to_wallet, shared_with FROM social_account_pool
     WHERE id = ? AND sold_to_wallet = ? AND status = 'sold'`
  ).get(id, ownerWallet) as { sold_to_wallet: string; shared_with: string | null } | undefined;
  if (!row) return null;
  const next = parseSharedWith(row.shared_with).filter(w => w !== withWallet);
  db.prepare(`UPDATE social_account_pool SET shared_with = ? WHERE id = ?`)
    .run(JSON.stringify(next), id);
  return next;
}

/**
 * Public-safe pool account summary — used by list endpoints so wallets
 * can see what they own / are shared without exposing creds.
 */
export interface PoolAccountSummary {
  id: string;
  platform: string;
  username: string;
  country: string | null;
  status: string;
  access: "owner" | "shared";
  shared_with?: string[];
}

export function poolListAccessibleSummaries(wallet: string, platform: string = "twitter"): PoolAccountSummary[] {
  const rows = db
    .prepare(
      `SELECT id, platform, username, country, status, sold_to_wallet, shared_with
       FROM social_account_pool
       WHERE platform = ?
         AND status = 'sold'
         AND (sold_to_wallet = ? OR shared_with LIKE ?)`
    )
    .all(platform, wallet, `%${wallet}%`) as Array<{
      id: string; platform: string; username: string; country: string | null;
      status: string; sold_to_wallet: string | null; shared_with: string | null;
    }>;

  return rows
    .filter(r => poolCanAccess(r, wallet))
    .map(r => {
      const isOwner = r.sold_to_wallet === wallet;
      const out: PoolAccountSummary = {
        id: r.id,
        platform: r.platform,
        username: r.username,
        country: r.country,
        status: r.status,
        access: isOwner ? "owner" : "shared",
      };
      if (isOwner) out.shared_with = parseSharedWith(r.shared_with);
      return out;
    });
}
