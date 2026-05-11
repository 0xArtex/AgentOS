import { Router, Request, Response } from "express";

const router = Router();

// In-memory webhook store (production would use DB)
const webhookStore: Map<string, { url: string; events: string[]; secret?: string; createdAt: string }> = new Map();

/**
 * POST /api/webhooks — Register a webhook for agent events
 */
router.post("/api/webhooks", (req: Request, res: Response) => {
  const { url, events, secret } = req.body || {};
  
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({
      error: "url and events[] required",
      supported_events: [
        "email.received", "email.sent",
        "phone.call.incoming", "phone.call.completed", "phone.sms.received",
        "compute.deploy", "compute.error", "compute.health",
        "domain.provisioned", "domain.ssl.renewed",
        "agent.registered", "agent.quota.warning"
      ],
      example: {
        url: "https://my-agent.example.com/webhook",
        events: ["email.received", "compute.error"],
        secret: "optional-hmac-secret"
      }
    });
  }

  const id = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  webhookStore.set(id, { url, events, secret, createdAt: new Date().toISOString() });

  res.status(201).json({
    id,
    url,
    events,
    status: "active",
    createdAt: new Date().toISOString(),
    note: "Webhooks will POST JSON payloads with HMAC-SHA256 signature in X-Palmyr-Signature header"
  });
});

/**
 * GET /api/webhooks — List registered webhooks
 */
router.get("/api/webhooks", (_req: Request, res: Response) => {
  const hooks = Array.from(webhookStore.entries()).map(([id, h]) => ({
    id, url: h.url, events: h.events, createdAt: h.createdAt
  }));
  
  res.json({
    webhooks: hooks,
    total: hooks.length,
    supported_events: [
      "email.received", "email.sent",
      "phone.call.incoming", "phone.call.completed", "phone.sms.received",
      "compute.deploy", "compute.error", "compute.health",
      "domain.provisioned", "domain.ssl.renewed",
      "agent.registered", "agent.quota.warning"
    ]
  });
});

/**
 * DELETE /api/webhooks/:id — Remove a webhook
 */
router.delete("/api/webhooks/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (webhookStore.has(id)) {
    webhookStore.delete(id);
    return res.json({ deleted: true, id });
  }
  res.status(404).json({ error: "Webhook not found" });
});

export default router;
