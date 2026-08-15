import { Router, Request, Response } from "express";
import { db } from "../db";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { rateLimit } from "../middleware/rateLimit";
import { clientIp } from "../middleware/client-ip";
import {
  cleanupExpiredPendingRegistrations,
  consumePendingRegistration,
  createPendingRegistration,
  normalizeContinuePath,
  resendPendingRegistration,
  signupProtectionConfigured,
  turnstileSiteKey,
  verifyTurnstile,
} from "../services/signup-protection";

const router = Router();
const SESSION_DAYS = 30;
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const signupRateLimit = rateLimit(5, 60 * 60_000);
const resendRateLimit = rateLimit(3, 60 * 60_000);

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
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function requireTurnstile(req: Request, res: Response): Promise<boolean> {
  const result = await verifyTurnstile(req.body?.turnstileToken, clientIp(req));
  if (result.ok) return true;
  if (result.unavailable) {
    console.error(`[auth] Turnstile unavailable: ${result.reason}`);
    res.status(503).json({ error: "Sign-up protection is temporarily unavailable. Please try again shortly.", code: "TURNSTILE_UNAVAILABLE" });
  } else {
    res.status(400).json({ error: "Please complete the anti-bot check and try again.", code: "TURNSTILE_FAILED" });
  }
  return false;
}

const VERIFY_MESSAGE = "Check your inbox for a verification link. It expires in 30 minutes.";

// The Turnstile site key is intentionally public; siteverify keeps the secret
// server-side. no-store makes key rotations visible to already-open clients.
router.get("/config", (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  res.json({ turnstileSiteKey: turnstileSiteKey(), signupAvailable: signupProtectionConfigured() });
});

// Create a pending registration and email a single-use activation link. No
// dashboard user or session exists until that link is consumed. The strict
// limiter and Turnstile both run before expensive scrypt hashing.
router.post("/register", signupRateLimit, async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const rawName = req.body?.name;
  if (!email || typeof password !== "string") return res.status(400).json({ error: "A valid email and password are required" });
  if (password.length < 10) return res.status(400).json({ error: "Password must be at least 10 characters" });
  if (password.length > 256) return res.status(400).json({ error: "Password must be at most 256 characters" });
  if (rawName !== undefined && typeof rawName !== "string") return res.status(400).json({ error: "Name must be a string" });
  const displayName = (typeof rawName === "string" ? rawName.trim() : "") || email.split("@")[0];
  if (displayName.length > 80) return res.status(400).json({ error: "Name must be at most 80 characters" });
  if (!await requireTurnstile(req, res)) return;

  // Turnstile and the per-IP signup limit run before this lookup, which keeps
  // automated enumeration expensive while giving real users the conventional
  // and much clearer "sign in instead" path.
  const existing = db.prepare("SELECT id FROM dashboard_users WHERE email = ?").get(email);
  if (existing) {
    return res.status(409).json({
      error: "An account with this email already exists. Sign in instead.",
      code: "ACCOUNT_EXISTS",
      login_required: true,
    });
  }

  try {
    cleanupExpiredPendingRegistrations();
    await createPendingRegistration({
      email,
      passwordHash: hashPassword(password),
      displayName,
      continuePath: normalizeContinuePath(req.body?.continuePath),
    });
    res.status(202).json({ verification_required: true, message: VERIFY_MESSAGE });
  } catch (error: any) {
    console.error(`[auth] verification email failed for pending registration: ${error?.message || error}`);
    res.status(503).json({ error: "We could not send the verification email. Please try again in a minute.", code: "EMAIL_SEND_FAILED" });
  }
});

// Generic response prevents account enumeration. The separate 3/hour/IP cap
// and 60-second per-address cooldown prevent email bombing.
router.post("/resend-verification", resendRateLimit, async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "A valid email is required" });
  if (!await requireTurnstile(req, res)) return;
  try {
    await resendPendingRegistration(email, normalizeContinuePath(req.body?.continuePath));
    res.json({ message: "If a verification is pending for that address, a fresh link is on its way." });
  } catch (error: any) {
    console.error(`[auth] verification resend failed: ${error?.message || error}`);
    res.status(503).json({ error: "We could not resend the verification email. Please try again later.", code: "EMAIL_SEND_FAILED" });
  }
});

// Consume a database-hashed, single-use token and only then materialize the
// active dashboard user. The user signs in with the password they chose.
router.get("/verify-email", (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  const result = consumePendingRegistration(req.query.token);
  if (result.ok) {
    const next = normalizeContinuePath(req.query.next || result.continuePath);
    return res.redirect(303, `${next}?email_verified=1`);
  }
  const reason = result.reason === "expired" ? "This verification link has expired." : "This verification link is invalid or has already been used.";
  res.status(400).type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Email verification</title></head><body style="margin:0;background:#112d32;color:#f7ead1;font-family:Arial,sans-serif"><main style="max-width:520px;margin:12vh auto;padding:32px"><div style="color:#F6AF56;font-weight:700;margin-bottom:28px">PALMYR</div><h1>Could not verify email</h1><p style="color:rgba(247,234,209,.7);line-height:1.6">${reason} Return to sign up and request a new one.</p><a href="/dashboard.html" style="color:#F6AF56">Back to Palmyr</a></main></body></html>`);
});

// POST /auth/login — email/password login
router.post("/login", (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || typeof password !== "string") return res.status(400).json({ error: "email and password required" });

  const user = db.prepare("SELECT * FROM dashboard_users WHERE email = ?").get(email) as any;
  if (!user || !user.password_hash) return res.status(401).json({ error: "Invalid email or password" });
  if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Invalid email or password" });
  if (!user.email_verified_at) return res.status(403).json({ error: "Verify your email before signing in", code: "EMAIL_NOT_VERIFIED" });

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
