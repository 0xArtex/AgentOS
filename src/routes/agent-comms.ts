import { Router, Response } from "express";
import { randomBytes } from "crypto";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// Agent-to-agent messaging system. Writes/reads the SAME `agent_messages`
// table that src/routes/messages.ts owns — schema is defined once in db.ts
// (id, from_agent, to_agent, subject, body, reply_to, read, created_at).
// The message text lives in the `body` column; there is no `priority` column,
// so priority is normalized for the response only (not persisted) to keep the
// schema dead-simple and shared with messages.ts.
//
// Every route requires a VERIFIED identity. requireAuth(0) sets req.agentId to
// the verified wallet identity (NEVER the raw X-Agent-Id header — that header by
// itself is publicly enumerable and proves nothing), so a caller can no longer
// read another agent's inbox, forge the `from` of a message, or mark someone
// else's messages read by spoofing a header. Mirrors src/routes/messages.ts.
//
// Every handler is wrapped in try/catch: a synchronous throw inside an Express
// handler that has already started responding can otherwise leak a stack; we
// always return clean JSON.
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

// POST /api/agent-comms/send - send a message FROM the authenticated agent.
// The sender is derived from the verified identity; a mismatching body `from`
// is rejected so the sender can never be forged from a header or request body.
router.post("/send", (req: AuthenticatedRequest, res: Response) => {
  try {
    const fromAgent = authedAgent(req);
    if (!fromAgent) {
      return res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
    }

    const { from, toAgent, subject, message, priority } = req.body ?? {};

    if (!toAgent || !message) {
      return res.status(400).json({ error: "toAgent and message required" });
    }

    // A body `from` is optional, but if supplied it MUST be the caller.
    if (from && !refersTo(fromAgent, from)) {
      return res.status(403).json({ error: "Forbidden Sender", message: "You can only send as your own authenticated agent." });
    }

    // Resolve the recipient to an agent row so to_agent stores the agent `id`,
    // consistent with messages.ts (the shared reader).
    const recipient = db
      .prepare("SELECT id, name FROM agents WHERE id = ? OR name = ? OR wallet_address = ?")
      .get(toAgent, toAgent, toAgent) as any;
    if (!recipient) {
      return res.status(404).json({ error: "Recipient Not Found", message: `Agent '${toAgent}' not found` });
    }

    const id = `msg_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const validPriority = ["low", "normal", "high", "urgent"].includes(priority) ? priority : "normal";
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO agent_messages (id, from_agent, to_agent, subject, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromAgent.id, recipient.id, subject || "(no subject)", message, now);

    res.json({
      id,
      status: "delivered",
      from: fromAgent.id,
      to: recipient.id,
      priority: validPriority,
      timestamp: now
    });
  } catch (err: any) {
    res.status(500).json({ error: "Send failed", message: err?.message ?? "Could not send message" });
  }
});

// GET /api/agent-comms/inbox - get messages for the authenticated agent. The
// inbox served is ALWAYS the caller's own; an optional `agentId` query is
// honored only when it refers to the caller, so no one can read another agent's
// inbox by passing a header or query param.
router.get("/inbox", (req: AuthenticatedRequest, res: Response) => {
  const me = authedAgent(req);
  if (!me) {
    return res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
  }

  const requested = req.query.agentId as string | undefined;
  if (requested && !refersTo(me, requested)) {
    return res.status(403).json({ error: "Forbidden", message: "You can only read your own inbox." });
  }

  const agentId = me.id;
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

// POST /api/agent-comms/read/:id - mark a message as read. Only the recipient
// (the authenticated agent) may do so.
router.post("/read/:id", (req: AuthenticatedRequest, res: Response) => {
  const me = authedAgent(req);
  if (!me) {
    return res.status(403).json({ error: "Not Registered", message: "Authenticated identity is not a registered agent." });
  }

  try {
    const msg = db.prepare("SELECT to_agent FROM agent_messages WHERE id = ?").get(req.params.id) as any;
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }
    if (msg.to_agent !== me.id) {
      return res.status(403).json({ error: "Forbidden", message: "Only the recipient can mark this message read." });
    }
    db.prepare("UPDATE agent_messages SET read = 1 WHERE id = ?").run(req.params.id);
    res.json({ id: req.params.id, status: "read" });
  } catch {
    res.status(404).json({ error: "Message not found" });
  }
});

// GET /api/agent-comms/stats - aggregate (non-tenant-specific) messaging stats.
router.get("/stats", (_req: AuthenticatedRequest, res: Response) => {
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
