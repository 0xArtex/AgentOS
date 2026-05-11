import { Router, Request, Response } from "express";
import { db } from "../db";
import { randomUUID } from "crypto";

const router = Router();

router.post("/", (req: Request, res: Response) => {
  const xAgent = (req.headers["x-agent-id"] as string) || "anonymous";
  const { name } = req.body || {};
  const agentName = name || xAgent;
  const results: Record<string, any> = {};
  const errors: string[] = [];

  // Register agent
  try {
    const existing: any = db.prepare("SELECT id FROM agents WHERE name = ?").get(agentName);
    if (existing) {
      results.agent = { registered: true, id: existing.id, existing: true };
    } else {
      const id = randomUUID();
      const token = randomUUID();
      db.prepare("INSERT INTO agents (id, name, description, token, created_at) VALUES (?, ?, ?, ?, ?)").run(id, agentName, "Provisioned via quicksetup", token, new Date().toISOString());
      results.agent = { registered: true, id, token, existing: false };
    }
  } catch (e: any) { errors.push("agent: " + e.message); }

  // Provision phone
  try {
    const phone = "+1555" + Math.floor(1000000 + Math.random() * 9000000);
    const id = randomUUID();
    db.prepare("INSERT INTO phone_numbers (id, phone_number, country, owner, provisioned_at) VALUES (?, ?, ?, ?, ?)").run(id, phone, "US", agentName, new Date().toISOString());
    results.phone = { id, number: phone, status: "active" };
  } catch (e: any) { errors.push("phone: " + e.message); }

  // Provision email
  try {
    const local = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const addr = local + "@agents.palmyr.dev";
    const id = randomUUID();
    db.prepare("INSERT INTO email_inboxes (id, address, local_part, owner, created_at) VALUES (?, ?, ?, ?, ?)").run(id, addr, local, agentName, new Date().toISOString());
    results.email = { id, address: addr, status: "active" };
  } catch (e: any) { errors.push("email: " + e.message); }

  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - Date.now()) / 3600000);

  res.json({
    success: errors.length === 0,
    message: errors.length === 0
      ? "Agent " + agentName + " fully provisioned with " + Object.keys(results).length + " services"
      : "Partial: " + Object.keys(results).length + " OK, " + errors.length + " errors",
    resources: results,
    errors: errors.length > 0 ? errors : undefined,
    hackathon: { mode: "FREE", hoursRemaining: Math.round(hoursLeft * 10) / 10, deadline: "2026-02-12T17:00:00Z" },
    nextSteps: ["POST /api/phone/send-sms", "POST /api/email/send", "GET /dashboard", "GET /docs"]
  });
});

router.get("/", (_req: Request, res: Response) => {
  res.json({
    endpoint: "POST /api/quicksetup",
    description: "One-call agent bootstrap: register + phone + email in a single request",
    usage: "curl -X POST http://77.42.89.233:3001/api/quicksetup -H Content-Type:application/json -d {name:my-agent}",
    hackathon: "100% FREE until Feb 12"
  });
});

export default router;
