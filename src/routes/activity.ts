import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

/**
 * GET /activity — Recent platform activity feed
 * Shows recent registrations, resource provisioning, messages
 */
router.get("/", (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const since = (req.query.since as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const events: any[] = [];

  // Recent agent registrations
  const agents = db.prepare(
    "SELECT id, name, created_at FROM agents WHERE created_at > ? ORDER BY created_at DESC LIMIT ?"
  ).all(since, limit) as any[];
  for (const a of agents) {
    events.push({ type: "agent.registered", agentId: a.id, agentName: a.name, at: a.created_at });
  }

  // Recent phone provisions
  const phones = db.prepare(
    "SELECT id, country, owner, provisioned_at FROM phone_numbers WHERE provisioned_at > ? ORDER BY provisioned_at DESC LIMIT ?"
  ).all(since, limit) as any[];
  for (const p of phones) {
    events.push({ type: "phone.provisioned", resourceId: p.id, country: p.country, agentId: p.owner, at: p.provisioned_at });
  }

  // Recent email inboxes
  const emails = db.prepare(
    "SELECT id, address, owner, created_at FROM email_inboxes WHERE created_at > ? ORDER BY created_at DESC LIMIT ?"
  ).all(since, limit) as any[];
  for (const e of emails) {
    events.push({ type: "email.created", resourceId: e.id, address: e.address, agentId: e.owner, at: e.created_at });
  }

  // Recent servers
  const servers = db.prepare(
    "SELECT id, name, server_type, owner, created_at FROM servers WHERE created_at > ? ORDER BY created_at DESC LIMIT ?"
  ).all(since, limit) as any[];
  for (const s of servers) {
    events.push({ type: "server.created", resourceId: s.id, name: s.name, serverType: s.server_type, agentId: s.owner, at: s.created_at });
  }

  // Recent messages
  const msgs = db.prepare(
    `SELECT m.id, fa.name as from_name, ta.name as to_name, m.subject, m.created_at
     FROM agent_messages m
     JOIN agents fa ON m.from_agent = fa.id
     JOIN agents ta ON m.to_agent = ta.id
     WHERE m.created_at > ?
     ORDER BY m.created_at DESC LIMIT ?`
  ).all(since, limit) as any[];
  for (const m of msgs) {
    events.push({ type: "message.sent", messageId: m.id, from: m.from_name, to: m.to_name, subject: m.subject, at: m.created_at });
  }

  // Sort all events by time descending
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({
    events: events.slice(0, limit),
    total: events.length,
    since,
  });
});

export default router;
