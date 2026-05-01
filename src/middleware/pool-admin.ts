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

const ADMIN_TIMESTAMP_SKEW_MS = 60_000;

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
    res.status(401).json({ error: `Signature verification failed: ${e.message}` });
    return;
  }

  next();
}
