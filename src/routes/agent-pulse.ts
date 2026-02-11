import { Router, Request, Response } from "express";
import os from "os";
import { db } from "../db";

const router = Router();

// GET /api/agent-pulse - Real-time platform pulse with live metrics
router.get("/", (_req: Request, res: Response) => {
  const now = Date.now();
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - now) / 3600000);

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

  const urgency = hoursLeft > 24 ? "BUILDING" : hoursLeft > 12 ? "CRUNCH_TIME" : hoursLeft > 6 ? "FINAL_SPRINT" : hoursLeft > 0 ? "LAST_STAND" : "SUBMITTED";

  res.json({
    pulse: "alive",
    urgency,
    hackathon: {
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      deadline: "2026-02-12T17:00:00Z",
      status: hoursLeft > 0 ? "ACTIVE" : "ENDED"
    },
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
      docs: "https://agntos.dev/docs",
      dashboard: "https://agntos.dev/dashboard",
      skill: "https://agntos.dev/skill.md",
      github: "https://github.com/0xArtex/AgentOS"
    }
  });
});

export default router;
