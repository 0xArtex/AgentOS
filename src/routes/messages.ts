import { validate } from "../middleware/validate";
import { Router, Request, Response } from "express";
import { db } from "../db";
import { notifyAgent } from "../services/notifications";

const router = Router({ mergeParams: true });

/**
 * POST /messages/send — Send a message from one agent to another
 * Free during hackathon, 0.01 USDC otherwise
 */
router.post("/send", (req: Request, res: Response) => {
  const { from, to, subject, body, replyTo } = req.body;

  if (!from || !to || !body) {
    res.status(400).json({
      error: "Missing Fields",
      message: "Fields 'from', 'to', and 'body' are required",
      hint: "from/to can be agent IDs or agent names",
    });
    return;
  }

  // Resolve agent names to IDs
  const fromAgent = db
    .prepare("SELECT id, name FROM agents WHERE id = ? OR name = ?")
    .get(from, from) as any;
  const toAgent = db
    .prepare("SELECT id, name FROM agents WHERE id = ? OR name = ?")
    .get(to, to) as any;

  if (!fromAgent) {
    res.status(404).json({ error: "Sender Not Found", message: `Agent '${from}' not found` });
    return;
  }
  if (!toAgent) {
    res.status(404).json({ error: "Recipient Not Found", message: `Agent '${to}' not found` });
    return;
  }

  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO agent_messages (id, from_agent, to_agent, subject, body, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, fromAgent.id, toAgent.id, subject || null, body, replyTo || null, now);

  // Notify recipient via webhook
  notifyAgent(toAgent.id, "message.received", {
    messageId: id,
    from: { id: fromAgent.id, name: fromAgent.name },
    subject: subject || null,
    body,
    replyTo: replyTo || null,
  }).catch(() => {});

  res.status(201).json({
    message: {
      id,
      from: { id: fromAgent.id, name: fromAgent.name },
      to: { id: toAgent.id, name: toAgent.name },
      subject: subject || null,
      body,
      replyTo: replyTo || null,
      createdAt: now,
    },
  });
});

/**
 * GET /messages/inbox/:agentId — Get messages for an agent
 */
router.get("/inbox/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const since = req.query.since as string || "1970-01-01";

  const messages = db
    .prepare(
      `SELECT m.id, m.subject, m.body, m.reply_to, m.read, m.created_at,
       fa.id as from_id, fa.name as from_name,
       ta.id as to_id, ta.name as to_name
       FROM agent_messages m
       JOIN agents fa ON m.from_agent = fa.id
       JOIN agents ta ON m.to_agent = ta.id
       WHERE m.to_agent = ? AND m.created_at > ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(agentId, since, limit) as any[];

  const unread = (
    db.prepare("SELECT COUNT(*) as c FROM agent_messages WHERE to_agent = ? AND read = 0").get(agentId) as any
  ).c;

  res.json({
    messages: messages.map((m) => ({
      id: m.id,
      from: { id: m.from_id, name: m.from_name },
      to: { id: m.to_id, name: m.to_name },
      subject: m.subject,
      body: m.body,
      replyTo: m.reply_to,
      read: !!m.read,
      createdAt: m.created_at,
    })),
    unread,
    total: messages.length,
  });
});

/**
 * POST /messages/:id/read — Mark a message as read
 */
router.post("/:id/read", (req: Request, res: Response) => {
  const result = db.prepare("UPDATE agent_messages SET read = 1 WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "Message Not Found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
