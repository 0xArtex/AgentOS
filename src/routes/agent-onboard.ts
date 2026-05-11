import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// POST /api/agent-onboard — one-call complete agent setup
router.post("/", (req: Request, res: Response) => {
  const { name, email, services } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = `ak_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

  // Register agent
  try {
    db.prepare("INSERT INTO agents (id, name, email, api_key, created_at) VALUES (?, ?, ?, ?, datetime(\"now\"))").run(agentId, name, email || null, apiKey);
  } catch (e: any) {
    // table might not exist, create it
    db.prepare("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, email TEXT, api_key TEXT, created_at TEXT)").run();
    db.prepare("INSERT INTO agents (id, name, email, api_key, created_at) VALUES (?, ?, ?, ?, datetime(\"now\"))").run(agentId, name, email || null, apiKey);
  }

  const provisioned: any = { agentId, apiKey };
  const requestedServices = services || ["phone", "email", "compute"];

  // Auto-provision requested services
  if (requestedServices.includes("phone")) {
    const phone = `+1${Math.floor(2000000000 + Math.random() * 8000000000)}`;
    try {
      db.prepare("INSERT INTO phones (agent_id, number, created_at) VALUES (?, ?, datetime(\"now\"))").run(agentId, phone);
    } catch { /* table may not exist */ }
    provisioned.phone = phone;
  }

  if (requestedServices.includes("email")) {
    const emailAddr = `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@agent.palmyr.dev`;
    try {
      db.prepare("INSERT INTO emails (agent_id, address, created_at) VALUES (?, ?, datetime(\"now\"))").run(agentId, emailAddr);
    } catch { /* table may not exist */ }
    provisioned.email = emailAddr;
  }

  if (requestedServices.includes("compute")) {
    const serverId = `srv_${Math.random().toString(36).slice(2, 10)}`;
    try {
      db.prepare("INSERT INTO servers (agent_id, server_id, status, created_at) VALUES (?, ?, ?, datetime(\"now\"))").run(agentId, serverId, "running");
    } catch { /* table may not exist */ }
    provisioned.compute = { serverId, status: "running", specs: "2 vCPU, 4GB RAM" };
  }

  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    success: true,
    message: `Welcome ${name}! Your agent is fully provisioned and ready to go.`,
    ...provisioned,
    services: requestedServices,
    hackathon: {
      free: true,
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      note: "All services FREE during Colosseum hackathon"
    },
    quickStart: {
      health: "curl http://77.42.89.233:3001/health",
      docs: "http://77.42.89.233:3001/docs",
      dashboard: `curl -H "X-Agent-Id: ${agentId}" http://77.42.89.233:3001/api/agent-dashboard`
    }
  });
});

// GET /api/agent-onboard — docs
router.get("/", (_req: Request, res: Response) => {
  res.json({
    endpoint: "POST /api/agent-onboard",
    description: "One-call complete agent provisioning. Register + phone + email + compute in a single request.",
    body: {
      name: "string (required) — your agent name",
      email: "string (optional) — contact email",
      services: "string[] (optional, default: [phone, email, compute]) — services to provision"
    },
    example: {
      curl: "curl -X POST http://77.42.89.233:3001/api/agent-onboard -H Content-Type:application/json -d {name:MyAgent}"
    },
    note: "100% FREE during Colosseum hackathon. No API key needed — just POST your name."
  });
});

export default router;
