import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// Initialize inbox table
db.exec(`CREATE TABLE IF NOT EXISTS agent_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  read_status INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Send a message to another agent
router.post("/", (req: Request, res: Response) => {
  const fromAgent = (req.headers["x-agent-id"] as string) || "anonymous";
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: "Missing required fields: to, subject, body" });
  }
  const stmt = db.prepare("INSERT INTO agent_inbox (from_agent, to_agent, subject, body) VALUES (?, ?, ?, ?)");
  const result = stmt.run(fromAgent, to, subject, body);
  res.status(201).json({ success: true, messageId: result.lastInsertRowid, from: fromAgent, to, subject });
});

// Get inbox
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });
  const unreadFilter = req.query.unread === "true" ? "AND read_status = 0" : "";
  const messages = db.prepare(`SELECT * FROM agent_inbox WHERE to_agent = ? ${unreadFilter} ORDER BY created_at DESC LIMIT 50`).all(agentId);
  const unread = (db.prepare("SELECT COUNT(*) as count FROM agent_inbox WHERE to_agent = ? AND read_status = 0").get(agentId) as any)?.count || 0;
  res.json({ agent: agentId, unread, messages });
});

// Mark as read
router.post("/:id/read", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });
  db.prepare("UPDATE agent_inbox SET read_status = 1 WHERE id = ? AND to_agent = ?").run(req.params.id, agentId);
  res.json({ success: true, messageId: req.params.id, read: true });
});

export default router;
