import { Router, Response } from "express";
import { db } from "../db";
import { notifyAgent } from "../services/notifications";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest } from "../types";

const router = Router({ mergeParams: true });

// Every route requires a VERIFIED identity. requireAuth(0) sets req.agentId to
// the verified wallet identity (never the raw X-Agent-Id header), so a caller
// can no longer read another agent's inbox, forge the `from` of a message, or
// mark someone else's messages read by spoofing a header.
router.use(requireAuth(0, "general"));

// Resolve the authenticated identity (a wallet address, or an agent id for
// legacy walletless rows) to its agent row. agent_messages.from_agent /
// to_agent store the agent `id`, so we map the verified identity → id here.
function authedAgent(req: AuthenticatedRequest): any | null {
  const me = req.agentId || req.payment?.payer;
  if (!me) return null;
  return db
    .prepare("SELECT id, name, wallet_address FROM agents WHERE wallet_address = ? OR id = ?")
    .get(me, me) as any;
}

// Does `identifier` (id / name / wallet) refer to this exact agent row?
function refersTo(agent: any, identifier: string): boolean {
  return identifier === agent.id || identifier === agent.name || identifier === agent.wallet_address;
}

/**
 * POST /messages/send — Send a message FROM the authenticated agent to another.
 * `from` is derived from the verified identity; a mismatching body `from` is
 * rejected so the sender can never be forged. Rate-limited per identity.
 */
router.post("/send", rateLimit(30, 60_000), (req: AuthenticatedRequest, res: Response) => {
  const fromAgent = authedAgent(req);
  if (!fromAgent) {
    res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
    return;
  }

  const { from, to, subject, body, replyTo } = req.body;

  if (!to || !body) {
    res.status(400).json({
      error: "Missing Fields",
      message: "Fields 'to' and 'body' are required",
      hint: "to can be an agent ID or agent name; from is your authenticated identity",
    });
    return;
  }

  // A body `from` is optional, but if supplied it MUST be the caller.
  if (from && !refersTo(fromAgent, from)) {
    res.status(403).json({ error: "Forbidden Sender", message: "You can only send as your own authenticated agent." });
    return;
  }

  const toAgent = db
    .prepare("SELECT id, name FROM agents WHERE id = ? OR name = ?")
    .get(to, to) as any;

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
 * GET /messages/inbox/:agentId — Get messages for an agent. The requested
 * owner MUST be the authenticated agent; otherwise 403. This stops any caller
 * from reading another agent's private messages.
 */
router.get("/inbox/:agentId", (req: AuthenticatedRequest, res: Response) => {
  const me = authedAgent(req);
  if (!me) {
    res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
    return;
  }

  // The :agentId param can be an id / name / wallet, but it must resolve to the
  // caller. We never serve an inbox the caller doesn't own.
  if (!refersTo(me, String(req.params.agentId))) {
    res.status(403).json({ error: "Forbidden", message: "You can only read your own inbox." });
    return;
  }

  const agentId = me.id;
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
 * POST /messages/:id/read — Mark a message as read. Only the recipient (the
 * authenticated agent) may do so.
 */
router.post("/:id/read", (req: AuthenticatedRequest, res: Response) => {
  const me = authedAgent(req);
  if (!me) {
    res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
    return;
  }

  const msgId = String(req.params.id);
  const msg = db.prepare("SELECT to_agent FROM agent_messages WHERE id = ?").get(msgId) as any;
  if (!msg) {
    res.status(404).json({ error: "Message Not Found" });
    return;
  }
  if (msg.to_agent !== me.id) {
    res.status(403).json({ error: "Forbidden", message: "Only the recipient can mark this message read." });
    return;
  }

  db.prepare("UPDATE agent_messages SET read = 1 WHERE id = ?").run(msgId);
  res.json({ ok: true });
});

export default router;
