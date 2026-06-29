/**
 * Pool-admin middleware — wallet-signature auth.
 *
 * Server env `POOL_ADMIN_WALLETS` = comma-separated Solana pubkeys allowed
 * to call admin endpoints. Client sends three headers:
 *   X-Admin-Pubkey:    admin's Solana pubkey (base58)
 *   X-Admin-Timestamp: unix ms when the signature was made
 *   X-Admin-Signature: Ed25519 sig (hex) over `<method>:<path>:<timestamp>`
 *
 * The timestamp must be within 60s of server time (prevents replay). The
 * pubkey must be in the whitelist. The signature must verify over the
 * bound message. No shared secrets; multi-admin is just adding a pubkey.
 */
import { Request, Response, NextFunction } from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createHash } from "crypto";
import { db } from "../db";

const ADMIN_TIMESTAMP_SKEW_MS = 60_000;

// Single-use signature store so a captured admin request can't be replayed
// verbatim inside the 60s skew window. We persist a hash of each accepted
// (pubkey, message, signature) tuple with a short TTL (just over the skew) and
// reject duplicates — mirroring the wallet_auth_nonces single-use pattern. The
// signed message already binds method+path+timestamp, so the signature itself
// is the nonce and the client signing format is unchanged.
db.exec(`
  CREATE TABLE IF NOT EXISTS pool_admin_used_sigs (
    sig_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )
`);

export function requirePoolAdmin(req: Request, res: Response, next: NextFunction): void {
  const whitelist = (process.env.POOL_ADMIN_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (whitelist.length === 0) {
    res.status(503).json({
      error: "Pool admin not configured",
      message: "POOL_ADMIN_WALLETS env is empty. Add admin Solana pubkey(s) comma-separated.",
    });
    return;
  }

  const pubkey = (req.headers["x-admin-pubkey"] || "") as string;
  const timestamp = (req.headers["x-admin-timestamp"] || "") as string;
  const signature = (req.headers["x-admin-signature"] || "") as string;

  if (!pubkey || !timestamp || !signature) {
    res.status(401).json({
      error: "Missing admin signature headers",
      message: "Required: X-Admin-Pubkey, X-Admin-Timestamp, X-Admin-Signature",
    });
    return;
  }

  if (!whitelist.includes(pubkey)) {
    res.status(403).json({ error: "Pubkey not in admin whitelist" });
    return;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ADMIN_TIMESTAMP_SKEW_MS) {
    res.status(401).json({
      error: "Timestamp stale or invalid",
      message: `Must be within ${ADMIN_TIMESTAMP_SKEW_MS / 1000}s of server time`,
    });
    return;
  }

  // Message binds the HTTP method and path so a signature for one route
  // can't be replayed against another. Use originalUrl so the mount prefix
  // is included — that's what the client signed.
  const message = `${req.method}:${req.originalUrl.split("?")[0]}:${timestamp}`;
  try {
    const pubkeyBytes = bs58.decode(pubkey);
    const sigBytes = Buffer.from(signature, "hex");
    const ok = nacl.sign.detached.verify(
      Buffer.from(message, "utf8"),
      sigBytes,
      pubkeyBytes
    );
    if (!ok) {
      res.status(401).json({ error: "Invalid admin signature" });
      return;
    }
  } catch (e: any) {
    // Only low-level decode noise (bad base58/hex) reaches here — log it
    // server-side rather than leaking internal lib errors to the caller.
    console.error("[pool-admin] signature verification error:", e);
    res.status(401).json({ error: "Invalid admin signature" });
    return;
  }

  // Replay guard: the signature is valid, but accept it at most once. Bind the
  // hash to pubkey + message + signature so a captured request can't be replayed
  // verbatim within the skew window. TTL is just over the skew; the timestamp
  // check above already rejects anything older, so an expired row can never
  // collide with a still-valid request.
  const now = Date.now();
  const sigHash = createHash("sha256")
    .update(`${pubkey}:${message}:${signature}`)
    .digest("hex");
  try {
    db.prepare("DELETE FROM pool_admin_used_sigs WHERE expires_at < ?").run(now);
    const info = db
      .prepare("INSERT OR IGNORE INTO pool_admin_used_sigs (sig_hash, expires_at) VALUES (?, ?)")
      .run(sigHash, now + ADMIN_TIMESTAMP_SKEW_MS + 1_000);
    if (info.changes === 0) {
      res.status(401).json({ error: "Admin signature already used (replay rejected)" });
      return;
    }
  } catch (e) {
    console.error("[pool-admin] replay-guard store error:", e);
    res.status(500).json({ error: "Admin replay guard unavailable" });
    return;
  }

  next();
}
