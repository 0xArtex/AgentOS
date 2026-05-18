import { v4 as uuid } from "uuid";
import { db } from "../db";

export interface XAccount {
  id: string;
  username: string;
  email: string;
  password: string;
  cookies: string; // JSON stringified cookie array
  auth_token: string | null;
  status: "available" | "reserved" | "sold" | "suspended";
  profile_name: string | null;
  profile_bio: string | null;
  profile_image: string | null;
  created_at: string;
  sold_at: string | null;
  sold_to: string | null; // owner wallet address
  shared_with: string[]; // wallets granted shared access (same creds, same session)
  warmed: boolean;
  age_days: number;
}

export class XAccountService {
  /**
   * Initialize the x_accounts table
   */
  async init(): Promise<void> {

    db.exec(`
      CREATE TABLE IF NOT EXISTS x_accounts (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        cookies TEXT DEFAULT '[]',
        auth_token TEXT,
        status TEXT DEFAULT 'available' CHECK(status IN ('available','reserved','sold','suspended')),
        profile_name TEXT,
        profile_bio TEXT,
        profile_image TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        sold_at TEXT,
        sold_to TEXT,
        shared_with TEXT DEFAULT '[]',
        warmed INTEGER DEFAULT 0,
        age_days INTEGER DEFAULT 0
      )
    `);

    // Idempotent backfill for older DBs that pre-date shared_with.
    const cols = db.prepare("PRAGMA table_info(x_accounts)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'shared_with')) {
      db.exec("ALTER TABLE x_accounts ADD COLUMN shared_with TEXT DEFAULT '[]'");
    }
  }

  /**
   * Add an account to the pool
   */
  async addAccount(account: {
    username: string;
    email: string;
    password: string;
    cookies?: string;
    auth_token?: string;
    profile_name?: string;
    profile_bio?: string;
    profile_image?: string;
    warmed?: boolean;
  }): Promise<XAccount> {
    
    const id = uuid();
    
    db.prepare(`
      INSERT INTO x_accounts (id, username, email, password, cookies, auth_token, profile_name, profile_bio, profile_image, warmed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      account.username,
      account.email,
      account.password,
      account.cookies || "[]",
      account.auth_token || null,
      account.profile_name || null,
      account.profile_bio || null,
      account.profile_image || null,
      account.warmed ? 1 : 0
    );

    return this.getAccount(id) as Promise<XAccount>;
  }

  /**
   * Get a specific account by ID
   */
  async getAccount(id: string): Promise<XAccount | null> {
    
    const row = db.prepare("SELECT * FROM x_accounts WHERE id = ?").get(id) as any;
    if (!row) return null;
    return this.rowToAccount(row);
  }

  /**
   * Get pool stats
   */
  async getPoolStats(): Promise<{
    available: number;
    reserved: number;
    sold: number;
    suspended: number;
    total: number;
  }> {
    
    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM x_accounts GROUP BY status
    `).all() as any[];

    const stats = { available: 0, reserved: 0, sold: 0, suspended: 0, total: 0 };
    for (const row of rows) {
      (stats as any)[row.status] = row.count;
      stats.total += row.count;
    }
    return stats;
  }

  /**
   * Purchase an account from the pool
   * Returns the oldest available warmed account, or oldest available if none warmed
   */
  async purchaseAccount(buyerWallet: string): Promise<XAccount | null> {
    

    // Prefer warmed accounts, ordered by age (oldest first = most trustworthy)
    let row = db.prepare(`
      SELECT * FROM x_accounts 
      WHERE status = 'available' AND warmed = 1
      ORDER BY created_at ASC 
      LIMIT 1
    `).get() as any;

    // Fallback to any available
    if (!row) {
      row = db.prepare(`
        SELECT * FROM x_accounts 
        WHERE status = 'available'
        ORDER BY created_at ASC 
        LIMIT 1
      `).get() as any;
    }

    if (!row) return null;

    // Mark as sold
    db.prepare(`
      UPDATE x_accounts 
      SET status = 'sold', sold_at = datetime('now'), sold_to = ?
      WHERE id = ?
    `).run(buyerWallet, row.id);

    return this.getAccount(row.id);
  }

  /**
   * Get account by username
   */
  async getByUsername(username: string): Promise<XAccount | null> {
    
    const row = db.prepare("SELECT * FROM x_accounts WHERE username = ?").get(username) as any;
    if (!row) return null;
    return this.rowToAccount(row);
  }

  /**
   * Update account status
   */
  async updateStatus(id: string, status: XAccount["status"]): Promise<void> {
    
    db.prepare("UPDATE x_accounts SET status = ? WHERE id = ?").run(status, id);
  }

  /**
   * Update account cookies (for session refresh)
   */
  async updateCookies(id: string, cookies: string): Promise<void> {
    
    db.prepare("UPDATE x_accounts SET cookies = ? WHERE id = ?").run(cookies, id);
  }

  /**
   * Mark account as suspended
   */
  async markSuspended(id: string): Promise<void> {
    await this.updateStatus(id, "suspended");
  }

  /**
   * List accounts by status
   */
  async listAccounts(status?: string, limit = 50): Promise<XAccount[]> {
    
    let rows: any[];
    if (status) {
      rows = db.prepare("SELECT * FROM x_accounts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as any[];
    } else {
      rows = db.prepare("SELECT * FROM x_accounts ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
    }
    return rows.map(r => this.rowToAccount(r));
  }

  /**
   * Update age_days for all accounts
   */
  async refreshAgeDays(): Promise<void> {
    
    db.exec(`
      UPDATE x_accounts 
      SET age_days = CAST((julianday('now') - julianday(created_at)) AS INTEGER)
    `);
  }

  private rowToAccount(row: any): XAccount {
    let shared: string[] = [];
    try { shared = row.shared_with ? JSON.parse(row.shared_with) : []; } catch { shared = []; }
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      password: row.password,
      cookies: row.cookies,
      auth_token: row.auth_token,
      status: row.status,
      profile_name: row.profile_name,
      profile_bio: row.profile_bio,
      profile_image: row.profile_image,
      created_at: row.created_at,
      sold_at: row.sold_at,
      sold_to: row.sold_to,
      shared_with: shared,
      warmed: !!row.warmed,
      age_days: row.age_days || 0,
    };
  }

  /**
   * True if `wallet` can read/use this account — either the sold_to owner
   * or in the shared_with list.
   */
  canAccess(account: Pick<XAccount, "sold_to" | "shared_with">, wallet: string): boolean {
    if (!wallet) return false;
    if (account.sold_to && account.sold_to === wallet) return true;
    return Array.isArray(account.shared_with) && account.shared_with.includes(wallet);
  }

  /**
   * Atomically flip the owner of an account and rewrite credentials. Caller
   * (typically the transfer route) is responsible for having actually rotated
   * the password / cookies / auth_token on X before calling this — this just
   * persists the new state. Clears shared_with: the prior owner's collaborators
   * don't transfer with the account.
   *
   * Returns the updated account, or null if `fromWallet` no longer matches
   * the current `sold_to` (a concurrent transfer happened).
   */
  async transferOwnership(
    id: string,
    fromWallet: string,
    toWallet: string,
    newCreds: { password: string; cookies: string; auth_token: string | null }
  ): Promise<XAccount | null> {
    const result = db.prepare(`
      UPDATE x_accounts
      SET sold_to = ?, password = ?, cookies = ?, auth_token = ?, shared_with = '[]'
      WHERE id = ? AND sold_to = ?
    `).run(toWallet, newCreds.password, newCreds.cookies, newCreds.auth_token, id, fromWallet);

    if (result.changes === 0) return null;
    return this.getAccount(id);
  }

  /**
   * Rewrite an account's stored credentials in place. Used by the unshare
   * --rotate flow where ownership doesn't change but the password and
   * cookies need to be rotated so a revoked share-holder can't keep using
   * cached creds. Does NOT touch sold_to or shared_with.
   */
  async updateCredentials(
    id: string,
    newCreds: { password: string; cookies: string; auth_token: string | null }
  ): Promise<XAccount | null> {
    db.prepare(`
      UPDATE x_accounts
      SET password = ?, cookies = ?, auth_token = ?
      WHERE id = ?
    `).run(newCreds.password, newCreds.cookies, newCreds.auth_token, id);
    return this.getAccount(id);
  }

  /**
   * Grant `withWallet` shared access. Idempotent — repeated calls do nothing.
   * Caller verifies `ownerWallet` matches sold_to.
   */
  async share(id: string, withWallet: string): Promise<XAccount | null> {
    const account = await this.getAccount(id);
    if (!account) return null;
    if (account.shared_with.includes(withWallet)) return account;
    if (account.sold_to === withWallet) return account; // owner is implicitly shared
    const next = [...account.shared_with, withWallet];
    db.prepare("UPDATE x_accounts SET shared_with = ? WHERE id = ?").run(JSON.stringify(next), id);
    return this.getAccount(id);
  }

  /**
   * Revoke `withWallet`'s shared access. Idempotent.
   */
  async unshare(id: string, withWallet: string): Promise<XAccount | null> {
    const account = await this.getAccount(id);
    if (!account) return null;
    const next = account.shared_with.filter(w => w !== withWallet);
    if (next.length === account.shared_with.length) return account;
    db.prepare("UPDATE x_accounts SET shared_with = ? WHERE id = ?").run(JSON.stringify(next), id);
    return this.getAccount(id);
  }

  /**
   * List accounts the wallet owns or has shared access to. Used by the new
   * owner after a transfer to discover what's been handed to them.
   */
  async accountsAccessibleBy(wallet: string): Promise<XAccount[]> {
    // SQLite has no native JSON contains; pull rows that name the wallet
    // anywhere in sold_to OR shared_with, then filter in JS to avoid
    // false positives from substring matches.
    const rows = db.prepare(`
      SELECT * FROM x_accounts
      WHERE sold_to = ? OR shared_with LIKE ?
    `).all(wallet, `%${wallet}%`) as any[];

    const accounts = rows.map(r => this.rowToAccount(r));
    return accounts.filter(a => this.canAccess(a, wallet));
  }
}

export const xAccountService = new XAccountService();
