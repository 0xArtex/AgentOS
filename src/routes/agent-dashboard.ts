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

  res.json({
    agent: {
      id: agentId,
      resources: { phones, emails, servers, domains },
      setupScore: Math.round(([phones, emails, servers, domains].filter(x => x > 0).length / 4) * 100),
      recommendations: [
        ...(phones === 0 ? ["Provision a phone: POST /phone/numbers"] : []),
        ...(emails === 0 ? ["Set up email: POST /email/inboxes"] : []),
        ...(servers === 0 ? ["Launch compute: POST /compute/servers"] : []),
        ...(domains === 0 ? ["Register domain: POST /domains/register"] : []),
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
    quickActions: {
      health: "GET /api/service-health",
      register: "POST /agents/register",
      phone: "POST /phone/numbers",
      email: "POST /email/inboxes",
      compute: "POST /compute/servers",
      billing: "GET /api/agent-billing",
      logs: "GET /api/logs",
      messages: "GET /api/agent-comms/inbox"
    },
    links: {
      docs: "https://palmyr.ai/docs",
      github: "https://github.com/0xArtex/Palmyr",
      skill: "https://palmyr.ai/skill.md"
    }
  });
});

export default router;
