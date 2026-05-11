import { Router, Request, Response } from "express";
import { db } from "../db";
import { v4 as uuid } from "uuid";

const router = Router({ mergeParams: true });

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

/**
 * POST /api/bootstrap — One-call full agent setup
 * Registers + provisions phone + email + compute in one request
 */
router.post("/", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) return res.status(400).json({ error: "Missing X-Agent-Id header" });

  const { name } = req.body || {};
  const provisioned: Record<string, any> = {};

  // Register
  const existing = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId);
  if (!existing) {
    db.prepare("INSERT INTO agents (agent_id, name, created_at) VALUES (?, ?, datetime('now'))").run(agentId, name || agentId);
    provisioned.agent = { status: "created" };
  } else {
    provisioned.agent = { status: "exists" };
  }

  // Phone
  const phoneNumber = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
  const phoneId = uuid();
  try {
    db.prepare("INSERT INTO phone_numbers (id, agent_id, phone_number, created_at) VALUES (?, ?, ?, datetime('now'))").run(phoneId, agentId, phoneNumber);
    provisioned.phone = { id: phoneId, number: phoneNumber };
  } catch(e: any) { provisioned.phone = { error: e.message }; }

  // Email
  const emailAddr = `${agentId}@palmyr.dev`;
  const emailId = uuid();
  try {
    db.prepare("INSERT INTO email_inboxes (id, agent_id, email_address, created_at) VALUES (?, ?, ?, datetime('now'))").run(emailId, agentId, emailAddr);
    provisioned.email = { id: emailId, address: emailAddr };
  } catch(e: any) { provisioned.email = { error: e.message }; }

  // Compute
  const serverId = uuid();
  const ip = `10.0.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  try {
    db.prepare("INSERT INTO servers (id, agent_id, ip_address, status, created_at) VALUES (?, ?, ?, 'running', datetime('now'))").run(serverId, agentId, ip);
    provisioned.compute = { id: serverId, ip };
  } catch(e: any) { provisioned.compute = { error: e.message }; }

  const hoursLeft = Math.max(0, (new Date("2026-02-12T17:00:00Z").getTime() - Date.now()) / 3600000);

  res.json({
    message: "Agent bootstrapped! Phone + Email + Compute provisioned in one call.",
    agentId,
    provisioned,
    hackathon: { free: true, hoursRemaining: Math.round(hoursLeft * 10) / 10 },
    quickstart: {
      sendSMS: `curl -X POST http://77.42.89.233:3001/api/sms/send -H 'X-Agent-Id: ${agentId}' -H 'Content-Type: application/json' -d '{"to":"+1234567890","body":"Hello from ${agentId}"}'`,
      sendEmail: `curl -X POST http://77.42.89.233:3001/api/email/send -H 'X-Agent-Id: ${agentId}' -H 'Content-Type: application/json' -d '{"to":"test@example.com","subject":"Hello","body":"From ${agentId}"}'`,
      checkHealth: `curl http://77.42.89.233:3001/api/service-health`
    }
  });
});

/**
 * GET /api/bootstrap — Info
 */
router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - Date.now()) / 3600000);
  
  res.json({
    endpoint: "POST /api/bootstrap",
    description: "One-call full agent setup: register + phone + email + compute",
    headers: { "X-Agent-Id": "your-agent-name" },
    optional_body: { name: "Display Name" },
    curl: "curl -X POST http://77.42.89.233:3001/api/bootstrap -H 'X-Agent-Id: my-agent' -H 'Content-Type: application/json'",
    hackathon: { free: true, hoursRemaining: Math.round(hoursLeft * 10) / 10, deadline: "Feb 12 17:00 UTC" },
    totalEndpoints: "99+",
    docs: "http://77.42.89.233:3001/docs"
  });
});

export default router;
