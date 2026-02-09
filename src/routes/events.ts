import { Router, Request, Response } from "express";

const router = Router();

/**
 * @swagger
 * /api/events/subscribe:
 *   post:
 *     summary: Subscribe to real-time agent events
 *     tags: [Events]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, events]
 *             properties:
 *               url: { type: string, description: "Webhook callback URL" }
 *               events: { type: array, items: { type: string }, description: "Event types to subscribe to" }
 *               secret: { type: string, description: "Optional HMAC secret for signature verification" }
 *     responses:
 *       201: { description: Subscription created }
 */
router.post("/subscribe", (req: Request, res: Response) => {
  const { url, events, secret } = req.body;
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({
      error: "Missing Required Fields",
      message: "Both url and events array are required",
      hint: "Events: sms.received, email.received, server.ready, server.error, domain.verified, agent.registered"
    });
  }

  const validEvents = [
    "sms.received", "sms.sent", "email.received", "email.sent",
    "server.ready", "server.error", "server.deleted",
    "domain.verified", "domain.expired",
    "agent.registered", "agent.updated",
    "payment.received", "payment.failed"
  ];

  const invalid = events.filter((e: string) => !validEvents.includes(e));
  if (invalid.length > 0) {
    return res.status(400).json({
      error: "Invalid Event Types",
      message: `Unknown events: ${invalid.join(", ")}`,
      hint: `Valid events: ${validEvents.join(", ")}`
    });
  }

  const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  res.status(201).json({
    subscriptionId,
    url,
    events,
    hasSecret: !!secret,
    status: "active",
    createdAt: new Date().toISOString(),
    note: "Webhook payloads include X-AgentOS-Signature header when secret is provided"
  });
});

/**
 * @swagger
 * /api/events/types:
 *   get:
 *     summary: List all available event types
 *     tags: [Events]
 *     responses:
 *       200: { description: Event type catalog }
 */
router.get("/types", (_req: Request, res: Response) => {
  res.json({
    categories: {
      communication: {
        events: ["sms.received", "sms.sent", "email.received", "email.sent"],
        description: "Triggered when messages are sent or received"
      },
      infrastructure: {
        events: ["server.ready", "server.error", "server.deleted"],
        description: "Server lifecycle events"
      },
      domains: {
        events: ["domain.verified", "domain.expired"],
        description: "Domain status changes"
      },
      agents: {
        events: ["agent.registered", "agent.updated"],
        description: "Agent registry events"
      },
      payments: {
        events: ["payment.received", "payment.failed"],
        description: "USDC payment events"
      }
    },
    webhook: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Event": "<event.type>",
        "X-AgentOS-Signature": "HMAC-SHA256 (if secret provided)",
        "X-AgentOS-Delivery": "<unique-delivery-id>"
      },
      retries: { maxAttempts: 3, backoff: "exponential", maxDelay: "300s" },
      timeout: "10s"
    }
  });
});

export default router;
