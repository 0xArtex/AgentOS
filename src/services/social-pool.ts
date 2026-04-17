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
}

export async function poolAdd(req: PoolAddRequest): Promise<PoolAddResult> {
  if (req.platform !== "twitter") {
    return { success: false, error: "Only twitter is supported right now" };
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
  const credsBlob = encrypt(JSON.stringify(req.credentials));
  const cookiesBlob = encrypt(JSON.stringify(cookies));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO social_account_pool (
      id, platform, username, country, age_category,
      proxy_session_id, credentials_encrypted, cookies_encrypted,
      acquired_cost_usdc, sale_price_usdc, status, created_at, tested_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`
  ).run(
    id,
    req.platform,
    req.username,
    req.country || null,
    req.age_category || null,
    proxySessionId,
    credsBlob,
    cookiesBlob,
    req.acquired_cost_usdc ?? null,
    req.sale_price_usdc,
    now,
    now,
    req.notes || null
  );

  return {
    success: true,
    id,
    proxy_session_id: proxySessionId,
    cookies_captured: cookies.length,
  };
}

export interface PoolBuyRequest {
  platform: "twitter";
  country?: string;
  age_category?: string;
  buyer_wallet: string;
}

export interface PoolBuyResult {
  success: boolean;
  account?: {
    id: string;
    platform: string;
    username: string;
    country: string | null;
    age_category: string | null;
    proxy_session_id: string;
    credentials: PoolCredentials;
    cookies: any[];
  };
  error?: string;
}

export function poolBuy(req: PoolBuyRequest): PoolBuyResult {
  if (req.platform !== "twitter") {
    return { success: false, error: "Only twitter is supported right now" };
  }
  if (!req.buyer_wallet) {
    return { success: false, error: "buyer_wallet is required" };
  }

  // Atomically reserve: find the oldest matching 'ready' row and flip it.
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM social_account_pool
         WHERE platform = ? AND status = 'ready'
           AND (? IS NULL OR country = ?)
           AND (? IS NULL OR age_category = ?)
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(
        req.platform,
        req.country || null,
        req.country || null,
        req.age_category || null,
        req.age_category || null
      ) as { id: string } | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE social_account_pool SET status='sold', sold_to_wallet=?, sold_at=?
         WHERE id=? AND status='ready'`
      )
      .run(req.buyer_wallet, now, row.id);
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
        (req.age_category ? `, age=${req.age_category}` : ""),
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
  recent_sales: Array<{ username: string; country: string | null; sold_to_wallet: string; sold_at: string }>;
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

  const recent_sales = (db
    .prepare(
      `SELECT username, country, sold_to_wallet, sold_at
       FROM social_account_pool
       WHERE status='sold'
       ORDER BY sold_at DESC
       LIMIT 10`
    )
    .all() as any[]).map((r) => ({
    username: r.username,
    country: r.country,
    sold_to_wallet: r.sold_to_wallet,
    sold_at: r.sold_at,
  }));

  return {
    total: counts.ready + counts.sold + counts.dead,
    ready: counts.ready,
    sold: counts.sold,
    dead: counts.dead,
    by_country,
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
