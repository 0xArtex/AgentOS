import { Router, Request, Response } from "express";
import os from "os";
import { db } from "../db";

const router = Router();

// GET /api/agent-pulse - Real-time platform pulse with live metrics
router.get("/", (_req: Request, res: Response) => {
  // Live DB counts
  const safeCount = (table: string): number => {
    try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
  };

  const agents = safeCount("agents");
  const phones = safeCount("phone_numbers");
  const emails = safeCount("email_inboxes");
  const servers = safeCount("servers");
  const totalRequests = safeCount("request_log");

  // System metrics
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // Recent activity (last hour)
  let recentRequests = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM request_log WHERE created_at > datetime(\"now\", \"-1 hour\")").get() as any;
    recentRequests = row?.c || 0;
  } catch {}

  // Top endpoints (last 24h)
  let topEndpoints: any[] = [];
  try {
    topEndpoints = db.prepare("SELECT path, COUNT(*) as hits FROM request_log WHERE created_at > datetime(\"now\", \"-24 hours\") GROUP BY path ORDER BY hits DESC LIMIT 5").all();
  } catch {}

  res.json({
    pulse: "alive",
    platform: {
      agents,
      phones,
      emails,
      servers,
      totalRequests,
      requestsLastHour: recentRequests,
      rpm: Math.round(recentRequests / 60 * 10) / 10,
      topEndpoints
    },
    system: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: Math.round(mem.heapUsed / 1048576),
      cpuCount: cpus.length,
      loadAvg: loadAvg.map(l => Math.round(l * 100) / 100),
      nodeVersion: process.version
    },
    links: {
      docs: "https://palmyr.ai/docs",
      dashboard: "https://palmyr.ai/dashboard",
      skill: "https://palmyr.ai/skill.md",
      github: "https://github.com/0xArtex/Palmyr"
    }
  });
});

export default router;
