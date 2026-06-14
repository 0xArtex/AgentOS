import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { db } from "../db";

const router = Router();

// Agent-to-agent messaging system. Writes/reads the SAME `agent_messages`
// table that src/routes/messages.ts owns — schema is defined once in db.ts
// (id, from_agent, to_agent, subject, body, reply_to, read, created_at).
// The message text lives in the `body` column; there is no `priority` column,
// so priority is normalized for the response only (not persisted) to keep the
// schema dead-simple and shared with messages.ts.
//
// Every handler is wrapped in try/catch: a synchronous throw inside an async
// Express handler becomes an unhandled rejection Express can't trap, hanging
// the request until timeout. Catching here always returns clean JSON.

// POST /api/agent-comms/send - send message between agents
router.post("/send", async (req: Request, res: Response) => {
  try {
    const fromAgent = req.headers["x-agent-id"] as string || "anonymous";
    const { toAgent, subject, message, priority } = req.body ?? {};

    if (!toAgent || !message) {
      return res.status(400).json({ error: "toAgent and message required" });
    }

    const id = `msg_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const validPriority = ["low", "normal", "high", "urgent"].includes(priority) ? priority : "normal";
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO agent_messages (id, from_agent, to_agent, subject, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromAgent, toAgent, subject || "(no subject)", message, now);

    res.json({
      id,
      status: "delivered",
      from: fromAgent,
      to: toAgent,
      priority: validPriority,
      timestamp: now
    });
  } catch (err: any) {
    res.status(500).json({ error: "Send failed", message: err?.message ?? "Could not send message" });
  }
});

// GET /api/agent-comms/inbox - get messages for an agent
router.get("/inbox", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string || req.query.agentId as string;
  if (!agentId) {
    return res.status(400).json({ error: "X-Agent-Id header or agentId query param required" });
  }

  
  try {
    const messages = db.prepare(`
      SELECT * FROM agent_messages WHERE to_agent = ? ORDER BY created_at DESC LIMIT 50
    `).all(agentId);
    
    const unread = db.prepare(`
      SELECT COUNT(*) as count FROM agent_messages WHERE to_agent = ? AND read = 0
    `).get(agentId) as any;

    res.json({ agentId, unread: unread?.count || 0, messages });
  } catch {
    res.json({ agentId, unread: 0, messages: [], note: "No messages yet" });
  }
});

// POST /api/agent-comms/read/:id - mark message as read  
router.post("/read/:id", (req: Request, res: Response) => {
  
  try {
    db.prepare("UPDATE agent_messages SET read = 1 WHERE id = ?").run(req.params.id);
    res.json({ id: req.params.id, status: "read" });
  } catch {
    res.status(404).json({ error: "Message not found" });
  }
});

// GET /api/agent-comms/stats - messaging stats
router.get("/stats", (_req: Request, res: Response) => {
  
  try {
    const total = db.prepare("SELECT COUNT(*) as count FROM agent_messages").get() as any;
    const unread = db.prepare("SELECT COUNT(*) as count FROM agent_messages WHERE read = 0").get() as any;
    const agents = db.prepare("SELECT COUNT(DISTINCT to_agent) as count FROM agent_messages").get() as any;
    
    res.json({
      totalMessages: total?.count || 0,
      unreadMessages: unread?.count || 0,
      uniqueRecipients: agents?.count || 0,
      service: "agent-comms",
      description: "Direct agent-to-agent messaging with inbox, priority levels, and read receipts"
    });
  } catch {
    res.json({ totalMessages: 0, unreadMessages: 0, uniqueRecipients: 0, service: "agent-comms" });
  }
});

export default router;
