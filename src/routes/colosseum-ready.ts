import { Router } from "express";
import { db } from "../db";
import os from "os";

const router = Router();

router.get("/colosseum-ready", async (_req, res) => {
  
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  const agents = db.prepare("SELECT COUNT(*) as c FROM agents").get() as any;
  const phones = db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any;
  const emails = db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any;
  const compute = db.prepare("SELECT COUNT(*) as c FROM servers").get() as any;
  const apikeys = db.prepare("SELECT COUNT(*) as c FROM api_keys").get() as any;

  const uptimeHours = (process.uptime() / 3600).toFixed(1);
  const memUsed = process.memoryUsage();

  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents — phone, email, compute, domains — one API call each",
    version: "v1.1.3",
    hackathon: {
      name: "Colosseum Agent Hackathon",
      deadline: deadline.toISOString(),
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      status: hoursLeft > 0 ? "ACTIVE" : "ENDED",
      freeForAgents: hoursLeft > 0,
      projectId: 432,
    },
    liveProof: {
      description: "Real database counts from a live production system",
      agents: agents?.c || 0,
      phones: phones?.c || 0,
      emails: emails?.c || 0,
      computeInstances: compute?.c || 0,
      apiKeys: apikeys?.c || 0,
      serverUptimeHours: parseFloat(uptimeHours),
      memoryUsedMB: Math.round(memUsed.heapUsed / 1048576),
      systemMemoryGB: parseFloat((os.totalmem() / 1073741824).toFixed(1)),
      timestamp: now.toISOString(),
    },
    services: [
      { name: "Phone", endpoint: "POST /api/phone/provision" },
      { name: "Email", endpoint: "POST /api/email/provision" },
      { name: "Compute", endpoint: "POST /api/compute/provision" },
      { name: "Domain", endpoint: "POST /api/domain/register" },
      { name: "Agent Registry", endpoint: "POST /api/agents/register" },
      { name: "One-Call Bootstrap", endpoint: "POST /api/bootstrap" },
      { name: "Analytics", endpoint: "GET /api/analytics" },
      { name: "Webhooks", endpoint: "POST /api/webhooks" },
    ],
    differentiators: [
      "Real provisioned infrastructure, not mock APIs",
      "x402 USDC payments — agents pay with crypto",
      "One API call per service — no account setup needed",
      "Free hackathon mode until Feb 12",
      "100+ API endpoints",
      "Sub-5ms average response time",
    ],
    tryIt: {
      hackathonInfo: "curl http://77.42.89.233:3001/api/hackathon",
      registerAgent: "curl -X POST http://77.42.89.233:3001/api/agents/register -H 'Content-Type: application/json' -d '{\"name\":\"test\"}'",
      systemOverview: "curl http://77.42.89.233:3001/api/system-overview",
      docs: "http://77.42.89.233:3001/docs",
    },
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/Palmyr",
    },
  });
});

export default router;
