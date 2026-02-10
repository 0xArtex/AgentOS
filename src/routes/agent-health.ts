import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router({ mergeParams: true });

/**
 * GET /api/agent-health/:agentId — Agent-specific health check & setup diagnostic
 * Tells an agent what services they have, what's working, and what to do next.
 */
router.get("/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return res.status(404).json({
      status: "not_found",
      message: `Agent '${agentId}' not registered. Register first: POST /agents`,
      quickFix: `curl -X POST http://77.42.89.233:3001/agents -H 'Content-Type: application/json' -d '{"name":"${agentId}"}'`
    });
  }

  const phones = db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE agent_id = ?").all(agentId) as any[];
  const emails = db.prepare("SELECT COUNT(*) as c FROM email_inboxes WHERE agent_id = ?").all(agentId) as any[];
  const servers = db.prepare("SELECT COUNT(*) as c FROM servers WHERE agent_id = ?").all(agentId) as any[];
  const domains = db.prepare("SELECT COUNT(*) as c FROM domains WHERE agent_id = ?").all(agentId) as any[];

  const phoneCount = phones[0]?.c || 0;
  const emailCount = emails[0]?.c || 0;
  const serverCount = servers[0]?.c || 0;
  const domainCount = domains[0]?.c || 0;

  const recentRequests = (db.prepare(
    "SELECT COUNT(*) as c FROM request_log WHERE created_at > datetime('now', '-1 hour')"
  ).get() as any)?.c || 0;

  const services = {
    phone: { provisioned: phoneCount, status: phoneCount > 0 ? "active" : "not_provisioned" },
    email: { provisioned: emailCount, status: emailCount > 0 ? "active" : "not_provisioned" },
    compute: { provisioned: serverCount, status: serverCount > 0 ? "active" : "not_provisioned" },
    domains: { provisioned: domainCount, status: domainCount > 0 ? "active" : "not_provisioned" },
  };

  const totalServices = phoneCount + emailCount + serverCount + domainCount;
  const setupScore = Math.min(100, Math.round((totalServices / 4) * 100));

  const recommendations: string[] = [];
  if (phoneCount === 0) recommendations.push("Provision a phone number for SMS/voice: POST /phone-numbers");
  if (emailCount === 0) recommendations.push("Create an email inbox: POST /email");
  if (serverCount === 0) recommendations.push("Spin up compute: POST /compute");
  if (domainCount === 0) recommendations.push("Register a domain: POST /domains");
  if (totalServices >= 4) recommendations.push("All core services active! Consider setting up webhooks: POST /api/webhooks");

  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      registeredAt: agent.created_at,
    },
    health: {
      overall: totalServices >= 2 ? "healthy" : totalServices >= 1 ? "partial" : "setup_needed",
      setupScore: `${setupScore}%`,
      servicesActive: totalServices,
    },
    services,
    activity: {
      platformRequestsLastHour: recentRequests,
    },
    recommendations,
    links: {
      docs: "http://77.42.89.233:3001/docs",
      analytics: `/api/analytics`,
      ecosystem: `/api/ecosystem`,
    },
  });
});

/**
 * GET /api/agent-health — General platform health for any agent
 */
router.get("/", (_req: Request, res: Response) => {
  const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.round(uptimeSeconds / 3600 * 10) / 10;

  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 3600000 * 10) / 10);

  res.json({
    platform: "AgentOS",
    status: "operational",
    version: "v1.0.3",
    uptime: `${uptimeHours}h`,
    registeredAgents: agents,
    endpoints: "91+",
    hackathon: {
      name: "Colosseum Agent Hackathon",
      hoursRemaining: hoursLeft,
      freeAccess: true,
      howTo: "Add X-Agent-Id header to any request",
    },
    services: ["phone", "email", "compute", "domains", "storage", "webhooks", "invoicing", "analytics"],
    quickStart: "POST /agents with {name: 'your-agent'} to get started",
    docs: "http://77.42.89.233:3001/docs",
  });
});

export default router;
