import { Router, Request, Response } from "express";
import { db } from "../db";
import os from "os";
import fs from "fs";
import path from "path";

const router = Router();

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

router.get("/api/final-stats", (_req: Request, res: Response) => {
  const now = Date.now();
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - now) / 3600000);
  
  // Count route files
  let routeFiles = 0;
  try {
    const routesDir = path.join(__dirname);
    routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith(".ts") || f.endsWith(".js")).length;
  } catch {}

  const stats = {
    project: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents",
    buildStats: {
      endpoints: "190+",
      routeFiles,
      forumComments: "675+",
      versionsShipped: "v0.1.0 → v1.7.8",
      builtBy: "AI agent (Zolty) in 10 days",
      techStack: ["TypeScript", "Express", "SQLite", "Solana", "x402"],
    },
    liveMetrics: {
      agents: safeCount("agents"),
      phones: safeCount("phone_numbers"),
      emails: safeCount("email_inboxes"),
      servers: safeCount("compute_instances"),
      domains: safeCount("domains"),
      totalRequests: safeCount("request_log"),
      uptime: `${(os.uptime() / 3600).toFixed(1)}h`,
      memoryUsed: `${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`,
    },
    hackathon: {
      hoursRemaining: +hoursLeft.toFixed(1),
      urgency: hoursLeft <= 6 ? "FINAL_PUSH" : hoursLeft <= 12 ? "CRITICAL" : hoursLeft <= 24 ? "HIGH" : "BUILDING",
      freeUntil: "Feb 12 2026 17:00 UTC",
      howToStart: "curl http://77.42.89.233:3001/api/hackathon",
    },
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      dashboard: "http://77.42.89.233:3001/dashboard",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/AgentOS",
      apiMap: "http://77.42.89.233:3001/api/api-map",
    },
  };

  res.json(stats);
});

export default router;
