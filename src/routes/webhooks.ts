import { Router, Request, Response } from "express";

const router = Router();

interface WebhookRegistration {
  id: string;
  agentId: string;
  url: string;
  events: string[];
  createdAt: string;
  active: boolean;
}

const webhooks: Map<string, WebhookRegistration[]> = new Map();

// Register a webhook
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const { url, events } = req.body;
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: "url (string) and events (string[]) required", validEvents: ["phone.call", "phone.sms", "email.received", "email.sent", "compute.complete", "domain.provisioned", "invoice.paid"] });
  }

  const registration: WebhookRegistration = {
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    url,
    events,
    createdAt: new Date().toISOString(),
    active: true
  };

  const existing = webhooks.get(agentId) || [];
  existing.push(registration);
  webhooks.set(agentId, existing);

  res.status(201).json({ webhook: registration, message: "Webhook registered. You will receive POST requests to your URL when matching events occur." });
});

// List webhooks
router.get("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const agentWebhooks = webhooks.get(agentId) || [];
  res.json({
    webhooks: agentWebhooks,
    count: agentWebhooks.length,
    availableEvents: ["phone.call", "phone.sms", "email.received", "email.sent", "compute.complete", "domain.provisioned", "invoice.paid"]
  });
});

// Delete webhook
router.delete("/:id", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(401).json({ error: "X-Agent-Id header required" });

  const agentWebhooks = webhooks.get(agentId) || [];
  const idx = agentWebhooks.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Webhook not found" });

  agentWebhooks.splice(idx, 1);
  webhooks.set(agentId, agentWebhooks);
  res.json({ message: "Webhook deleted" });
});

export default router;
