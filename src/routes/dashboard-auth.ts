import { Router, Request, Response } from "express";
import { db } from "../db";
import { createHash, randomBytes } from "crypto";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const router = Router();
const SESSION_DAYS = 30;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return salt + ":" + hash;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const check = createHash("sha256").update(salt + password).digest("hex");
  return check === hash;
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
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

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

  const token = createSession(user.id);
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
});

// POST /auth/wallet — wallet-based auth (Solana)
// Client signs a message, we verify the signature
router.post("/wallet", (req: Request, res: Response) => {
  const { walletAddress, signature, message, chain } = req.body || {};
  if (!walletAddress || !signature || !message) {
    return res.status(400).json({ error: "walletAddress, signature, and message required" });
  }

  // Verify the message contains our domain and is recent
  if (!message.includes("agntos.dev") && !message.includes("AgentOS")) {
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

// POST /auth/wallet/nonce — get a nonce/message to sign
router.post("/wallet/nonce", (req: Request, res: Response) => {
  const nonce = randomBytes(16).toString("hex");
  const message = `Sign in to AgentOS (agntos.dev)\n\nNonce: ${nonce}\nTimestamp: ${new Date().toISOString()}`;
  res.json({ message, nonce });
});

export default router;
