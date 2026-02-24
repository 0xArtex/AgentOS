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
  sold_to: string | null; // agent wallet address
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
        warmed INTEGER DEFAULT 0,
        age_days INTEGER DEFAULT 0
      )
    `);
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
      warmed: !!row.warmed,
      age_days: row.age_days || 0,
    };
  }
}

export const xAccountService = new XAccountService();
