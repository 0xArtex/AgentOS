import { Router, Request, Response } from "express";
import os from "os";
import fs from "fs";
import path from "path";
import { db } from "../db";

const router = Router();

function safeCount(db: any, table: string, where?: string): number {
  try {
    const q = where ? `SELECT COUNT(*) as c FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as c FROM ${table}`;
    return (db.prepare(q).get() as any)?.c || 0;
  } catch { return 0; }
}

// GET /api/agent-dashboard?agent=<id> — comprehensive agent control panel
router.get("/", (req: Request, res: Response) => {
  const agentId = (req.query.agent as string) || req.headers["x-agent-id"] as string || "anonymous";
  

  // Agent-specific stats
  const phones = safeCount(db, "phones", `agent_id = '${agentId}'`);
  const emails = safeCount(db, "emails", `agent_id = '${agentId}'`);
  const servers = safeCount(db, "servers", `agent_id = '${agentId}'`);
  const domains = safeCount(db, "domains", `agent_id = '${agentId}'`);

  // Platform stats
  const totalAgents = safeCount(db, "agents");
  const totalRequests = safeCount(db, "request_log");

  // System health
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const cpuLoad = os.loadavg();

  // Route count
  let routeCount = 0;
  try {
    const routeDir = path.join(__dirname);
    routeCount = fs.readdirSync(routeDir).filter(f => f.endsWith(".ts") || f.endsWith(".js")).length;
  } catch {}

  // Hackathon countdown
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    agent: {
      id: agentId,
      resources: { phones, emails, servers, domains },
      setupScore: Math.round(([phones, emails, servers, domains].filter(x => x > 0).length / 4) * 100),
      recommendations: [
        ...(phones === 0 ? ["Provision a phone: POST /api/phones/provision"] : []),
        ...(emails === 0 ? ["Set up email: POST /api/emails/provision"] : []),
        ...(servers === 0 ? ["Launch compute: POST /api/compute/provision"] : []),
        ...(domains === 0 ? ["Register domain: POST /api/domains/register"] : []),
      ]
    },
    platform: {
      totalAgents,
      totalRequests,
      endpoints: routeCount + "+",
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      cpuLoad: cpuLoad[0].toFixed(2),
      status: "operational"
    },
    hackathon: {
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      deadline: deadline.toISOString(),
      status: hoursLeft > 24 ? "building" : hoursLeft > 6 ? "crunch-time" : hoursLeft > 0 ? "final-sprint" : "submitted",
      freeAccess: true,
      tip: hoursLeft > 24 ? "Explore all services — everything is free" : "Ship what you have, polish the demo"
    },
    quickActions: {
      health: "GET /api/service-health",
      register: "POST /api/agents/register",
      phone: "POST /api/phones/provision",
      email: "POST /api/emails/provision",
      compute: "POST /api/compute/provision",
      billing: "GET /api/agent-billing",
      logs: "GET /api/agent-logs",
      messages: "GET /api/agent-comms/inbox"
    },
    links: {
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "http://77.42.89.233:3001/skill.md"
    }
  });
});

export default router;
