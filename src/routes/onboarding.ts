import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router({ mergeParams: true });

/**
 * POST /onboarding/quickstart — One-call agent setup: register + provision phone + email
 */
router.post("/quickstart", (req: Request, res: Response) => {
  const { name, description, walletAddress, webhookUrl } = req.body;

  if (!name || typeof name !== "string" || name.length < 2) {
    res.status(400).json({
      error: "Invalid Agent Name",
      message: "Agent name must be at least 2 characters",
      hint: "POST /onboarding/quickstart with { name: \"my-agent\" }",
    });
    return;
  }

  const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(name);
  if (existing) {
    res.status(409).json({
      error: "Agent Name Taken",
      message: `An agent named '${name}' already exists`,
    });
    return;
  }

  const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const token = `agt_${Array.from({ length: 48 }, () => Math.random().toString(36)[2]).join("")}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, name, description || null, walletAddress || null, webhookUrl || null, token, now);

  const phoneId = `ph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const phoneNumber = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
  db.prepare(
    `INSERT INTO phone_numbers (id, phone_number, country, owner, provisioned_at, active)
     VALUES (?, ?, 'US', ?, ?, 1)`
  ).run(phoneId, phoneNumber, agentId, now);

  const emailId = `em_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const emailAddress = `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@agent.palmyr.dev`;
  db.prepare(
    `INSERT INTO email_inboxes (id, address, owner, created_at, active)
     VALUES (?, ?, ?, ?, 1)`
  ).run(emailId, emailAddress, agentId, now);

  res.status(201).json({
    message: "Agent created with starter resources! You're ready to build.",
    agent: { id: agentId, name, description: description || null, token },
    resources: {
      phone: { id: phoneId, number: phoneNumber, country: "US" },
      email: { id: emailId, address: emailAddress },
    },
    nextSteps: [
      "Use X-Agent-Token header with your token for authenticated requests",
      "Send SMS: POST /phone/numbers/{phoneId}/sms",
      "Send email: POST /email/inboxes/{emailId}/send",
      "Provision more: POST /phone/numbers, POST /email/inboxes, POST /compute/servers",
      "Check your profile: GET /agents/{agentId}",
    ],
    docs: "http://77.42.89.233:3001/docs",
  });
});

/**
 * GET /onboarding/guide — Step-by-step integration guide
 */
router.get("/guide", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Integration Guide",
    steps: [
      { step: 1, title: "Quick Start", endpoint: "POST /onboarding/quickstart", body: { name: "my-agent" }, note: "Returns agent token + phone + email in one call" },
      { step: 2, title: "Or Register Manually", endpoint: "POST /agents/register", body: { name: "my-agent" } },
      { step: 3, title: "Provision Resources", endpoints: ["POST /phone/numbers", "POST /email/inboxes", "POST /compute/servers"] },
      { step: 4, title: "Use Resources", endpoints: ["POST /phone/numbers/:id/sms", "POST /email/inboxes/:id/send"] },
      { step: 5, title: "Monitor", endpoints: ["GET /agents/:id", "GET /agents/:id/resources", "GET /activity"] },
    ],
    hackathon: { mode: "FREE until Feb 12, 2026", limits: "5 phones, 5 emails, 2 servers per agent", auth: "X-Agent-Id header (any string)" },
  });
});

export default router;
