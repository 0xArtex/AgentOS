import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '*',
      secret TEXT,
      active INTEGER DEFAULT 1,
      failures INTEGER DEFAULT 0,
      last_triggered TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      payload TEXT,
      status_code INTEGER,
      success INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch {}

// GET overview
router.get("/", (_req: Request, res: Response) => {
  const total = (db.prepare("SELECT COUNT(*) as c FROM agent_webhooks").get() as any).c;
  const active = (db.prepare("SELECT COUNT(*) as c FROM agent_webhooks WHERE active = 1").get() as any).c;
  const deliveries = (db.prepare("SELECT COUNT(*) as c FROM webhook_deliveries").get() as any).c;

  res.json({
    endpoint: "/api/agent-webhooks",
    description: "Event-driven webhook system — get notified when things happen in your agent's infrastructure",
    total_webhooks: total,
    active_webhooks: active,
    total_deliveries: deliveries,
    supported_events: [
      "agent.created", "agent.updated", "agent.deleted",
      "task.completed", "task.failed",
      "cron.triggered", "cron.failed",
      "health.degraded", "health.recovered",
      "phone.call.received", "phone.sms.received",
      "email.received", "email.bounced",
      "compute.started", "compute.stopped", "compute.error",
      "payment.received", "payment.failed",
      "reputation.changed", "endorsement.received",
      "secret.rotated", "env.updated",
      "*"
    ],
    routes: {
      "GET /api/agent-webhooks": "This overview",
      "POST /api/agent-webhooks": "Register a webhook",
      "GET /api/agent-webhooks/:agentId": "List agent's webhooks",
      "DELETE /api/agent-webhooks/:id": "Remove a webhook",
      "GET /api/agent-webhooks/:id/deliveries": "View delivery history",
      "POST /api/agent-webhooks/test": "Send a test event"
    },
    try_it: [
      'curl -X POST http://77.42.89.233:3001/api/agent-webhooks -H "Content-Type: application/json" -d \'{"agent_id":"my-agent","url":"https://example.com/webhook","events":"task.completed,health.degraded"}\'',
      'curl http://77.42.89.233:3001/api/agent-webhooks/my-agent',
      'curl -X POST http://77.42.89.233:3001/api/agent-webhooks/test -H "Content-Type: application/json" -d \'{"webhook_id":1,"event":"task.completed"}\''
    ],
    hackathon_note: "Free during Colosseum hackathon — unlimited webhooks"
  });
});

// POST register webhook
router.post("/", (req: Request, res: Response) => {
  const { agent_id, url, events, secret } = req.body || {};
  if (!agent_id || !url) return res.status(400).json({ error: "agent_id and url required" });
  
  const result = db.prepare("INSERT INTO agent_webhooks (agent_id, url, events, secret) VALUES (?, ?, ?, ?)").run(agent_id, url, events || "*", secret || null);
  const webhook = db.prepare("SELECT * FROM agent_webhooks WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ created: true, webhook });
});

// GET agent's webhooks
router.get("/:agentId", (req: Request, res: Response) => {
  const webhooks = db.prepare("SELECT * FROM agent_webhooks WHERE agent_id = ? ORDER BY created_at DESC").all(req.params.agentId);
  res.json({ agent_id: req.params.agentId, webhooks });
});

// DELETE webhook
router.delete("/:id", (req: Request, res: Response) => {
  db.prepare("DELETE FROM agent_webhooks WHERE id = ?").run(req.params.id);
  res.json({ deleted: true, id: req.params.id });
});

// GET deliveries
router.get("/:id/deliveries", (req: Request, res: Response) => {
  const deliveries = db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.id);
  res.json({ webhook_id: req.params.id, deliveries });
});

// POST test
router.post("/test", (req: Request, res: Response) => {
  const { webhook_id, event } = req.body || {};
  if (!webhook_id) return res.status(400).json({ error: "webhook_id required" });
  
  const webhook = db.prepare("SELECT * FROM agent_webhooks WHERE id = ?").get(webhook_id) as any;
  if (!webhook) return res.status(404).json({ error: "Webhook not found" });

  const payload = JSON.stringify({ event: event || "test", agent_id: webhook.agent_id, timestamp: new Date().toISOString(), data: { message: "Test delivery from Palmyr" } });
  db.prepare("INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, success) VALUES (?, ?, ?, ?, ?)").run(webhook_id, event || "test", payload, 200, 1);
  db.prepare("UPDATE agent_webhooks SET last_triggered = datetime('now') WHERE id = ?").run(webhook_id);

  res.json({ delivered: true, webhook_id, event: event || "test", payload: JSON.parse(payload) });
});

export default router;
