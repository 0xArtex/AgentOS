import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";

const router = Router();
const dbPath = path.join(process.cwd(), "data", "secrets.db");

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

function obfuscate(text: string, agentId: string): string {
  const key = agentId.repeat(Math.ceil(text.length / agentId.length));
  return Buffer.from(
    text.split("").map((c, i) => c.charCodeAt(0) ^ key.charCodeAt(i))
  ).toString("base64");
}

function deobfuscate(encoded: string, agentId: string): string {
  const bytes = Buffer.from(encoded, "base64");
  const key = agentId.repeat(Math.ceil(bytes.length / agentId.length));
  return Array.from(bytes).map((b, i) => String.fromCharCode(b ^ key.charCodeAt(i))).join("");
}

// Store a secret
router.post("/", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const { key, value } = req.body;
  if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
  const db = getDb();
  try {
    db.prepare(`INSERT OR REPLACE INTO secrets (agent_id, key, value_encrypted, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(agentId, key, obfuscate(value, agentId));
    res.json({ stored: true, key, agent_id: agentId });
  } finally { db.close(); }
});

// List keys (not values)
router.get("/", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, created_at, updated_at FROM secrets WHERE agent_id = ?").all(agentId);
    res.json({ agent_id: agentId, keys: rows, count: (rows as any[]).length });
  } finally { db.close(); }
});

// Get a secret
router.get("/:key", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const key = req.params.key;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value_encrypted FROM secrets WHERE agent_id = ? AND key = ?").get(agentId, key) as any;
    if (!row) { res.status(404).json({ error: "not found" }); return; }
    res.json({ key, value: deobfuscate(row.value_encrypted, agentId), agent_id: agentId });
  } finally { db.close(); }
});

// Delete a secret
router.delete("/:key", (req: Request, res: Response) => {
  const agentId = (req.headers["x-agent-id"] as string) || "anonymous";
  const key = req.params.key;
  const db = getDb();
  try {
    const result = db.prepare("DELETE FROM secrets WHERE agent_id = ? AND key = ?").run(agentId, key);
    if (result.changes === 0) { res.status(404).json({ error: "not found" }); return; }
    res.json({ deleted: true, key });
  } finally { db.close(); }
});

export default router;
