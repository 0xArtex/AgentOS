import { Router, Request, Response } from "express";
import { db } from "../db.js";

const router = Router();

// GET /api/agent-config/:agentId - Get agent configuration profile
router.get("/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId;

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const phones = db.prepare("SELECT id, phone_number, status, created_at FROM phones WHERE agent_id = ?").all(agentId);
  const emails = db.prepare("SELECT id, address, status, created_at FROM emails WHERE agent_id = ?").all(agentId);
  const computes = db.prepare("SELECT id, status, specs, created_at FROM compute_instances WHERE agent_id = ?").all(agentId);
  const domains = db.prepare("SELECT id, domain, status, created_at FROM domains WHERE agent_id = ?").all(agentId);

  res.json({
    agent: { id: agent.id, name: agent.name, created_at: agent.created_at },
    services: {
      phones: { count: phones.length, items: phones },
      emails: { count: emails.length, items: emails },
      compute: { count: computes.length, items: computes },
      domains: { count: domains.length, items: domains },
    },
    limits: { max_phones: 5, max_emails: 10, max_compute: 3, max_domains: 5 },
    recommendations: [
      phones.length === 0 ? "Provision a phone number for SMS/voice capabilities" : null,
      emails.length === 0 ? "Set up an email address for communication workflows" : null,
      computes.length === 0 ? "Provision compute for background tasks and simulations" : null,
    ].filter(Boolean),
  });
});

// PUT /api/agent-config/:agentId/preferences - Update agent preferences
router.put("/:agentId/preferences", (req: Request, res: Response) => {
  const agentId = req.params.agentId;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const prefs = {
    notification_webhook: req.body.notification_webhook || null,
    auto_renew: req.body.auto_renew !== false,
    preferred_region: req.body.preferred_region || "us-east",
    log_level: req.body.log_level || "info",
  };

  res.json({ agent_id: agentId, preferences: prefs, message: "Preferences updated" });
});

export default router;
