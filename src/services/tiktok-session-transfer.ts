/**
 * Session transfer relay — move a TikTok session from the machine that can log
 * in (a real browser on a trusted/home IP) to the machine that runs the ops
 * (the Studio VPS), without ever putting the session on disk server-side.
 *
 * Why this exists: TikTok's login is its most bot-hardened surface and refuses
 * to AUTHORIZE a login into a server browser through a datacenter/proxy IP
 * (confirmed empirically — both headless and headed-via-Xvfb were rejected at
 * the phone-confirm step). The only environment TikTok trusts is a real browser
 * on a real residential IP — i.e. the operator's laptop, where `tiktok connect`
 * already works. So: connect on the laptop → `push` the harvested session here →
 * `pull` it down on the VPS into its vault.
 *
 * Model (mirrors the connect claim_token): the session is held IN MEMORY (never
 * written to disk), keyed by a high-entropy one-time `transfer_code` returned
 * only to the pusher. `pull` redeems the code once and the entry is wiped. Short
 * TTL bounds exposure; a server restart just means re-push (no persistence).
 *
 * The code is the capability — treat it like a password while it's live.
 */
import { randomBytes } from "crypto";

interface Entry { cookies: any[]; label?: string; expiresAt: number; }

const store = new Map<string, Entry>();
const TTL_MS = 30 * 60 * 1000;           // 30 min — ample to copy the code to the VPS
const MAX_ENTRIES = 500;
const MAX_COOKIES = 200;                  // a TikTok jar is a few dozen cookies
const MAX_BYTES = 256 * 1024;             // sanity cap on the serialized jar

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
}
function evictIfFull(): void {
  if (store.size < MAX_ENTRIES) return;
  let oldestKey: string | undefined, oldestAt = Infinity;
  for (const [k, v] of store) if (v.expiresAt < oldestAt) { oldestAt = v.expiresAt; oldestKey = k; }
  if (oldestKey) store.delete(oldestKey);
}

/**
 * Stash a session jar and return a one-time transfer code. Validates the jar is
 * a sane, bounded cookie array (this is a session relay, not a general store).
 */
export function stashSession(cookies: any[], label?: string): { transfer_code: string; expires_in_sec: number } {
  if (!Array.isArray(cookies) || cookies.length === 0) throw new Error("cookies must be a non-empty array");
  if (cookies.length > MAX_COOKIES) throw new Error("too many cookies");
  if (JSON.stringify(cookies).length > MAX_BYTES) throw new Error("session payload too large");
  pruneExpired();
  evictIfFull();
  const transfer_code = randomBytes(24).toString("hex");
  store.set(transfer_code, { cookies, label, expiresAt: Date.now() + TTL_MS });
  return { transfer_code, expires_in_sec: Math.round(TTL_MS / 1000) };
}

export interface ClaimedSession { cookies: any[]; label?: string; }

/**
 * Redeem a transfer code ONCE. Returns the jar and wipes the entry so a replayed
 * code can't re-leak the session. null if unknown/expired.
 */
export function claimSession(transferCode: string): ClaimedSession | null {
  if (!transferCode || typeof transferCode !== "string") return null;
  const e = store.get(transferCode);
  if (!e) return null;
  store.delete(transferCode);                 // one-time, regardless of expiry
  if (Date.now() > e.expiresAt) return null;  // expired → treat as gone
  return { cookies: e.cookies, label: e.label };
}
