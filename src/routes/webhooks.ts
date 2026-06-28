import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// SCOPE NOTE — provider callbacks vs. agent management.
// Every route in THIS file is agent-facing webhook *registration/management*
// (register a delivery URL, list your registrations, delete one). There are NO
// inbound provider-callback paths here: provider callbacks live in their own
// routers and stay unauthenticated-but-signature-verified —
//   • src/routes/phone.ts  → POST /phone/webhooks/telnyx, /phone/webhooks/voice
//   • src/routes/email.ts  → POST /email/webhooks (and Mailgun inbound)
// so gating this router with requireAuth does NOT touch any provider sink.
//
// requireAuth(0) sets req.agentId to the verified wallet identity (never the
// raw X-Agent-Id header), so a caller can no longer register/list/delete
// webhooks for another agent by spoofing a header. The store is keyed on
// req.agentId.
router.use(requireAuth(0, "general"));

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
router.post("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }

  const { url, events } = req.body;
  if (!url || !events || !Array.isArray(events)) {
    res.status(400).json({ error: "url (string) and events (string[]) required", validEvents: ["phone.call", "phone.sms", "email.received", "email.sent", "compute.complete", "domain.provisioned", "invoice.paid"] });
    return;
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
router.get("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }

  const agentWebhooks = webhooks.get(agentId) || [];
  res.json({
    webhooks: agentWebhooks,
    count: agentWebhooks.length,
    availableEvents: ["phone.call", "phone.sms", "email.received", "email.sent", "compute.complete", "domain.provisioned", "invoice.paid"]
  });
});

// Delete webhook
router.delete("/:id", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) { res.status(401).json({ error: "authentication required" }); return; }

  const agentWebhooks = webhooks.get(agentId) || [];
  const idx = agentWebhooks.findIndex(w => w.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Webhook not found" }); return; }

  agentWebhooks.splice(idx, 1);
  webhooks.set(agentId, agentWebhooks);
  res.json({ message: "Webhook deleted" });
});

export default router;
