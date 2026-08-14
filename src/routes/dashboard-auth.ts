import { Router, Request, Response } from "express";
import { db } from "../db";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const router = Router();
const SESSION_DAYS = 30;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * scrypt password hashing. Format: "scrypt:<N>:<r>:<p>:<salt-hex>:<hash-hex>".
 * Legacy rows use "<salt-hex>:<sha256-hex>" and are accepted on login so
 * existing users can log in once; on successful login we upgrade the stored
 * hash to scrypt transparently.
 */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
// scrypt's working memory is ~128·N·r bytes ≈ 32 MB at N=2^15, r=8, which meets or
// exceeds Node's DEFAULT maxmem (32 MB) and makes scryptSync throw "memory limit
// exceeded" on OpenSSL 3 builds (register/login then 500). Raise the ceiling so
// hashing AND verifying work; it must cover both the current N and any stored N.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("scrypt:")) {
    const parts = stored.split(":");
    if (parts.length !== 6) return false;
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  // Legacy format: "<salt-hex>:<sha256-hex>".
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = createHash("sha256").update(salt + password).digest("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLegacyHash(stored: string): boolean {
  return !stored.startsWith("scrypt:");
}

function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    "INSERT INTO dashboard_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)"
  ).run(crypto.randomUUID(), userId, token, expires);
  return token;
}

// POST /auth/register — email/password signup
router.post("/register", (req: Request, res: Response) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  if (password.length < 10) return res.status(400).json({ error: "Password must be at least 10 characters" });

  const existing = db.prepare("SELECT id FROM dashboard_users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const userId = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  db.prepare(
    "INSERT INTO dashboard_users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)"
  ).run(userId, email.toLowerCase(), passwordHash, name || email.split("@")[0]);

  const token = createSession(userId);
  res.json({ token, user: { id: userId, email, display_name: name || email.split("@")[0] } });
});

// POST /auth/login — email/password login
router.post("/login", (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const user = db.prepare("SELECT * FROM dashboard_users WHERE email = ?").get(email.toLowerCase()) as any;
  if (!user || !user.password_hash) return res.status(401).json({ error: "Invalid email or password" });
  if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Invalid email or password" });

  // Silently upgrade legacy SHA-256 hashes to scrypt on successful login.
  if (isLegacyHash(user.password_hash)) {
    try {
      db.prepare("UPDATE dashboard_users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
    } catch {}
  }

  const token = createSession(user.id);
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
});

// POST /auth/wallet — wallet-based auth (Solana)
// Client signs a server-issued nonce. Nonces are one-time and short-lived —
// captured signatures cannot be replayed.
router.post("/wallet", (req: Request, res: Response) => {
  const { walletAddress, signature, message, chain } = req.body || {};
  if (!walletAddress || !signature || !message) {
    return res.status(400).json({ error: "walletAddress, signature, and message required" });
  }

  // Extract the nonce from the signed message and validate it against our store.
  const nonceMatch = /Nonce:\s*([a-f0-9]{32})/i.exec(String(message));
  if (!nonceMatch) {
    return res.status(400).json({ error: "Message must include a server-issued nonce. Call POST /auth/wallet/nonce first." });
  }
  const nonce = nonceMatch[1].toLowerCase();

  // Atomically check + consume (single-use). Reject if missing, expired, or used.
  const consume = db.transaction((n: string) => {
    const row = db.prepare(
      "SELECT expires_at, used FROM wallet_auth_nonces WHERE nonce = ?"
    ).get(n) as { expires_at: number; used: number } | undefined;
    if (!row) return "unknown_nonce";
    if (row.used) return "nonce_already_used";
    if (Date.now() > row.expires_at) return "nonce_expired";
    db.prepare("UPDATE wallet_auth_nonces SET used = 1 WHERE nonce = ?").run(n);
    return "ok";
  });

  const consumeResult = consume(nonce);
  if (consumeResult !== "ok") {
    return res.status(401).json({ error: "Nonce validation failed: " + consumeResult });
  }

  // Verify the message still mentions our domain (defence in depth — the nonce is the real bind).
  if (!String(message).includes("palmyr.ai") && !String(message).includes("Palmyr")) {
    return res.status(400).json({ error: "Invalid message format" });
  }

  // Verify signature (Solana ed25519)
  try {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = bs58.decode(signature);
    const pubBytes = new PublicKey(walletAddress).toBytes();
    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    if (!valid) return res.status(401).json({ error: "Invalid signature" });
  } catch (e: any) {
    return res.status(401).json({ error: "Signature verification failed: " + e.message });
  }

  // Find or create user
  let user = db.prepare("SELECT * FROM dashboard_users WHERE wallet_address = ?").get(walletAddress) as any;
  if (!user) {
    const userId = crypto.randomUUID();
    const shortAddr = walletAddress.slice(0, 4) + "..." + walletAddress.slice(-4);
    db.prepare(
      "INSERT INTO dashboard_users (id, wallet_address, wallet_chain, display_name) VALUES (?, ?, ?, ?)"
    ).run(userId, walletAddress, chain || "solana", shortAddr);
    user = { id: userId, wallet_address: walletAddress, display_name: shortAddr };
  }

  const token = createSession(user.id);
  res.json({ token, user: { id: user.id, wallet_address: walletAddress, display_name: user.display_name } });
});

// GET /auth/me — get current user from session token
router.get("/me", (req: Request, res: Response) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  const session = db.prepare(
    "SELECT s.*, u.email, u.wallet_address, u.display_name FROM dashboard_sessions s JOIN dashboard_users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).get(token) as any;

  if (!session) return res.status(401).json({ error: "Session expired or invalid" });

  res.json({
    id: session.user_id,
    email: session.email,
    wallet_address: session.wallet_address,
    display_name: session.display_name,
  });
});

// POST /auth/logout
router.post("/logout", (req: Request, res: Response) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token) db.prepare("DELETE FROM dashboard_sessions WHERE token = ?").run(token);
  res.json({ success: true });
});

// POST /auth/wallet/nonce — get a one-time nonce + message to sign.
router.post("/wallet/nonce", (_req: Request, res: Response) => {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + NONCE_TTL_MS;
  db.prepare(
    "INSERT INTO wallet_auth_nonces (nonce, expires_at, used) VALUES (?, ?, 0)"
  ).run(nonce, expiresAt);
  // Opportunistic GC of expired nonces (cheap — indexed).
  try {
    db.prepare("DELETE FROM wallet_auth_nonces WHERE expires_at < ?").run(Date.now() - NONCE_TTL_MS);
  } catch {}
  const message = `Sign in to Palmyr (palmyr.ai)\n\nNonce: ${nonce}\nTimestamp: ${new Date().toISOString()}`;
  res.json({ message, nonce });
});

export default router;
