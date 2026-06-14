import { Router, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { DATA_DIR } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();
const dbPath = path.join(DATA_DIR, "secrets.db");

// Every route requires a verified identity. requireAuth(0) lets registered
// agents (aos_/agt_ token) through for free and sets req.agentId to the
// VERIFIED wallet identity — never the raw X-Agent-Id header.
router.use(requireAuth(0, "general"));

function getDb() {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS secrets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_encrypted TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, key)
  )`);
  return db;
}

// ─── Encryption at rest (AES-256-GCM) ───
// Mirrors the deposit-wallet pattern (src/services/deposit-wallets.ts): a
// server-side 32-byte hex master key held in env only, NOT keyed on the public
// agent id. A stolen secrets.db file alone is useless without SECRETS_MASTER_KEY.
const MASTER_KEY_ENV = "SECRETS_MASTER_KEY";
const ENC_PREFIX = "enc:v1:";

function getMasterKey(): Buffer {
  const hex = process.env[MASTER_KEY_ENV];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Never silently fall back to a publicly-known all-zero key just because
    // NODE_ENV isn't 'production'. Require an explicit opt-in for the dev key.
    if (process.env.ALLOW_INSECURE_SECRETS_KEY !== "1") {
      throw new Error(`${MASTER_KEY_ENV} must be a 64-char hex string (32 bytes). Set ALLOW_INSECURE_SECRETS_KEY=1 only for local dev.`);
    }
    // Local-dev opt-in only. Never set this flag in any deployed env.
    return Buffer.from("00".repeat(32), "hex");
  }
  return Buffer.from(hex, "hex");
}

function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}.${ct.toString("hex")}.${tag.toString("hex")}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy obfuscated/plaintext row. The old XOR was keyed on the agent id,
    // which we no longer have a clean way to reverse here; surface a clear
    // error rather than returning garbage. Such rows should be re-stored.
    throw new Error("secret stored under a legacy format; please re-store it");
  }
  const [iv, ct, tag] = stored.slice(ENC_PREFIX.length).split(".");
  const key = getMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let pt = decipher.update(ct, "hex", "utf8");
  pt += decipher.final("utf8");
  return pt;
}

// Store a secret
router.post("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }
  const { key, value } = req.body;
  if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
  const db = getDb();
  try {
    db.prepare(`INSERT OR REPLACE INTO secrets (agent_id, key, value_encrypted, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(agentId, key, encryptSecret(value));
    res.json({ stored: true, key, agent_id: agentId });
  } finally { db.close(); }
});

// List keys (not values)
router.get("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }
  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, created_at, updated_at FROM secrets WHERE agent_id = ?").all(agentId);
    res.json({ agent_id: agentId, keys: rows, count: (rows as any[]).length });
  } finally { db.close(); }
});

// Get a secret
router.get("/:key", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }
  const key = req.params.key;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value_encrypted FROM secrets WHERE agent_id = ? AND key = ?").get(agentId, key) as any;
    if (!row) { res.status(404).json({ error: "not found" }); return; }
    res.json({ key, value: decryptSecret(row.value_encrypted), agent_id: agentId });
  } finally { db.close(); }
});

// Delete a secret
router.delete("/:key", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }
  const key = req.params.key;
  const db = getDb();
  try {
    const result = db.prepare("DELETE FROM secrets WHERE agent_id = ? AND key = ?").run(agentId, key);
    if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
    res.json({ deleted: true, key });
  } finally { db.close(); }
});

export default router;
