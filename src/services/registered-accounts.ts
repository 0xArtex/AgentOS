/**
 * Wallet-registered social accounts: users upload their X credentials ONCE,
 * the server encrypts them at rest, and from then on can re-login on the
 * wallet's behalf to refresh cookies whenever they go stale.
 *
 * Foundation for server-side scheduling — schedules can fire whether or not
 * the user's machine is on, because the server holds everything it needs.
 *
 * Encryption: AES-256-GCM with a 32-byte master key from the
 * `REGISTERED_ACCOUNTS_KEY` env var. Wallet binding is enforced at the API
 * layer (every read/write filters by `wallet`) so a leaked account_id is
 * useless to a different wallet — same defense-in-depth pattern as the pool.
 *
 * Threat model:
 *   ✅ DB leak alone: ciphertext only, useless without the env var
 *   ✅ Cross-wallet API leak: blocked at every CRUD function
 *   ❌ Server fully compromised (DB + env): credentials decryptable. Same
 *      trade-off as Buffer/Hootsuite/every "we hold OAuth tokens" SaaS.
 *      Migrate to KMS / per-wallet client-held keys as a v2 enhancement.
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
  const hex = process.env.REGISTERED_ACCOUNTS_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "REGISTERED_ACCOUNTS_KEY must be set to a 64-char hex string (32 bytes). " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
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

export interface RegisteredCredentials {
  login: string;
  password: string;
  email?: string;
  email_password?: string;
  totp_seed?: string;
  auth_token?: string;
  ct0?: string;
}

export interface RegisterAccountRequest {
  wallet: string;
  platform: "twitter";
  username: string;
  credentials: RegisteredCredentials;
  country?: string;
}

export interface RegisterAccountResult {
  success: boolean;
  id?: string;
  username?: string;
  cookies_captured?: number;
  error?: string;
  login_error_code?: string;
}

/**
 * Register a wallet-owned account. Runs a real X login through a fresh
 * residential session to (a) verify the credentials work and (b) seed a
 * cookie cache so the first scheduled fire doesn't have to log in.
 *
 * Synchronous — blocks on the login (~10-30s). Same UX as `pool-add`.
 */
export async function registerAccount(req: RegisterAccountRequest): Promise<RegisterAccountResult> {
  if (req.platform !== "twitter") {
    return { success: false, error: "Only twitter is supported right now" };
  }
  if (!req.wallet) {
    return { success: false, error: "wallet is required" };
  }
  if (!req.username || !req.credentials?.password) {
    return { success: false, error: "username and credentials.password are required" };
  }

  // Reject re-register only for live rows. Revoked rows (soft-deleted by
  // `unregister`) can be reactivated in place — we keep the original id and
  // proxy_session_id so the IPRoyal sticky-IP continuity survives, and history
  // (completed schedules pointing at this account_id) stays linked.
  const existing = db
    .prepare(
      `SELECT id, status, proxy_session_id FROM social_registered_accounts WHERE wallet=? AND platform=? AND username=?`
    )
    .get(req.wallet, req.platform, req.username) as
      | { id: string; status: string; proxy_session_id: string }
      | undefined;
  if (existing && existing.status !== "revoked") {
    return {
      success: false,
      error: `Account "${req.username}" is already registered to this wallet (id: ${existing.id}, status: ${existing.status}). Unregister first to re-register with new credentials.`,
    };
  }

  // For reactivation, reuse the existing id + proxy_session_id. For fresh
  // registration, generate new ones.
  const id = existing ? existing.id : randomUUID().replace(/-/g, "");
  const proxySessionId = existing ? existing.proxy_session_id : id;

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
      error: `Login verification failed: ${loginResult.error || "unknown"}. Credentials NOT stored.`,
      login_error_code: loginResult.error_code,
    };
  }

  const cookies = loginResult.cookies || [];
  const credsBlob = encrypt(JSON.stringify(req.credentials));
  const cookiesBlob = encrypt(JSON.stringify(cookies));
  const now = new Date().toISOString();

  if (existing) {
    // Reactivation: refresh credentials + cookies, flip back to active.
    // registered_at intentionally preserved so audit shows original signup.
    db.prepare(
      `UPDATE social_registered_accounts
       SET credentials_encrypted=?, cookies_encrypted=?, last_login_at=?, status='active', country=?
       WHERE id=?`
    ).run(credsBlob, cookiesBlob, now, req.country || null, id);
  } else {
    db.prepare(
      `INSERT INTO social_registered_accounts (
        id, wallet, platform, username, country, proxy_session_id,
        credentials_encrypted, cookies_encrypted, status,
        registered_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(
      id,
      req.wallet,
      req.platform,
      req.username,
      req.country || null,
      proxySessionId,
      credsBlob,
      cookiesBlob,
      now,
      now
    );
  }

  return {
    success: true,
    id,
    username: req.username,
    cookies_captured: cookies.length,
  };
}

/**
 * Public-safe registration record — never includes credentials or cookies.
 */
export interface RegisteredAccountSummary {
  id: string;
  platform: string;
  username: string;
  country: string | null;
  status: "active" | "session_expired" | "revoked";
  registered_at: string;
  last_login_at: string | null;
  last_used_at: string | null;
}

export function listRegisteredAccounts(wallet: string, platform?: string): RegisteredAccountSummary[] {
  const rows = db
    .prepare(
      `SELECT id, platform, username, country, status, registered_at, last_login_at, last_used_at
       FROM social_registered_accounts
       WHERE wallet = ?
         AND (? IS NULL OR platform = ?)
         AND status != 'revoked'
       ORDER BY registered_at DESC`
    )
    .all(wallet, platform || null, platform || null) as RegisteredAccountSummary[];
  return rows;
}

export interface UnregisterResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Soft-delete: flips status to 'revoked' AND wipes the encrypted credential
 * + cookie blobs. The row stays for audit, but no decryptable data remains.
 * A future hard-delete cron can purge revoked rows after a retention window.
 */
export function unregisterAccount(wallet: string, accountId: string): UnregisterResult {
  const row = db
    .prepare(`SELECT id, status FROM social_registered_accounts WHERE id=? AND wallet=?`)
    .get(accountId, wallet) as { id: string; status: string } | undefined;
  if (!row) {
    return { success: false, error: `No registered account "${accountId}" found for this wallet.` };
  }
  if (row.status === "revoked") {
    return { success: true, id: accountId };                 // already revoked, idempotent
  }
  db.prepare(
    `UPDATE social_registered_accounts
     SET status='revoked', credentials_encrypted='', cookies_encrypted=NULL
     WHERE id=? AND wallet=?`
  ).run(accountId, wallet);
  return { success: true, id: accountId };
}

/* ─── Worker-facing: get a ready-to-use session ─────────────────────────
   Used in PR 3 (the scheduling worker). Returns the cookies + proxy session
   needed to call postTweet/etc. directly. If cached cookies are >12h old
   (or missing), re-logs in via the stored credentials and updates the row.
*/

export interface ResolvedSession {
  account_id: string;                // == proxy_session_id
  username: string;
  cookies: any[];
  proxy_session_id: string;
}

export class SessionResolveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "SessionResolveError";
  }
}

const COOKIE_FRESH_HOURS = 12;

export async function getResolvedSession(
  wallet: string,
  accountId: string
): Promise<ResolvedSession> {
  const row = db
    .prepare(
      `SELECT id, username, proxy_session_id, credentials_encrypted, cookies_encrypted,
              last_login_at, status
       FROM social_registered_accounts
       WHERE id=? AND wallet=?`
    )
    .get(accountId, wallet) as {
      id: string;
      username: string;
      proxy_session_id: string;
      credentials_encrypted: string;
      cookies_encrypted: string | null;
      last_login_at: string | null;
      status: string;
    } | undefined;

  if (!row) {
    throw new SessionResolveError("ACCOUNT_NOT_FOUND", `No registered account "${accountId}" for this wallet`);
  }
  if (row.status === "revoked") {
    throw new SessionResolveError("ACCOUNT_REVOKED", `Account "${accountId}" was revoked`);
  }

  const ageMs = row.last_login_at ? Date.now() - new Date(row.last_login_at).getTime() : Infinity;
  const ageHours = ageMs / (1000 * 60 * 60);

  if (row.cookies_encrypted && ageHours <= COOKIE_FRESH_HOURS) {
    // Cached cookies are fresh enough — use them.
    const cookies = JSON.parse(decrypt(row.cookies_encrypted)) as any[];
    db.prepare(`UPDATE social_registered_accounts SET last_used_at=? WHERE id=?`)
      .run(new Date().toISOString(), accountId);
    return {
      account_id: row.id,
      username: row.username,
      cookies,
      proxy_session_id: row.proxy_session_id,
    };
  }

  // Stale or missing cookies — re-login using stored credentials.
  const creds = JSON.parse(decrypt(row.credentials_encrypted)) as RegisteredCredentials;
  const loginResult = await loginTwitter({
    account_id: row.id,
    proxy_session_id: row.proxy_session_id,
    login: creds.login,
    password: creds.password,
    totp_seed: creds.totp_seed,
    auth_token: creds.auth_token,
    ct0: creds.ct0,
  });

  if (!loginResult.success) {
    // Mark session_expired so the worker can surface this state via /registered
    // and the user knows to update credentials (e.g. password rotated, 2FA changed).
    db.prepare(`UPDATE social_registered_accounts SET status='session_expired' WHERE id=?`)
      .run(accountId);
    throw new SessionResolveError(
      loginResult.error_code || "LOGIN_FAILED",
      `Re-login failed for "${row.username}": ${loginResult.error || "unknown"}. Account marked session_expired — update credentials via re-register.`
    );
  }

  const newCookies = loginResult.cookies || [];
  const newCookiesBlob = encrypt(JSON.stringify(newCookies));
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE social_registered_accounts
     SET cookies_encrypted=?, last_login_at=?, last_used_at=?, status='active'
     WHERE id=?`
  ).run(newCookiesBlob, now, now, accountId);

  return {
    account_id: row.id,
    username: row.username,
    cookies: newCookies,
    proxy_session_id: row.proxy_session_id,
  };
}
