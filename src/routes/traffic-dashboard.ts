import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/traffic-dashboard", async (_req: Request, res: Response) => {
  
  const now = Date.now();
  const hourAgo = now - 3600000;
  const dayAgo = now - 86400000;

  // Safe count helper
  const safeCount = (query: string, params: any[] = []): number => {
    try {
      const row = db.prepare(query).get(...params) as any;
      return row?.count || 0;
    } catch { return 0; }
  };

  const totalAgents = safeCount("SELECT COUNT(*) as count FROM agents");
  const totalPhones = safeCount("SELECT COUNT(*) as count FROM phones");
  const totalEmails = safeCount("SELECT COUNT(*) as count FROM emails");
  const totalServers = safeCount("SELECT COUNT(*) as count FROM servers");
  const totalRequests = safeCount("SELECT COUNT(*) as count FROM request_logs");
  const last24h = safeCount("SELECT COUNT(*) as count FROM request_logs WHERE timestamp > ?", [dayAgo]);
  const lastHour = safeCount("SELECT COUNT(*) as count FROM request_logs WHERE timestamp > ?", [hourAgo]);

  // Top endpoints
  let topEndpoints: any[] = [];
  try {
    topEndpoints = db.prepare(
      "SELECT path, COUNT(*) as hits FROM request_logs GROUP BY path ORDER BY hits DESC LIMIT 10"
    ).all() as any[];
  } catch {}

  // Unique agents today
  let uniqueAgents = 0;
  try {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT agent_id) as count FROM request_logs WHERE timestamp > ? AND agent_id IS NOT NULL"
    ).get(dayAgo) as any;
    uniqueAgents = row?.count || 0;
  } catch {}

  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (deadline - now) / 3600000);

  res.json({
    title: "AgentOS — Live Traffic Dashboard",
    generated_at: new Date().toISOString(),
    hackathon_hours_remaining: Math.round(hoursLeft * 10) / 10,
    traffic: {
      total_requests: totalRequests,
      last_24h: last24h,
      last_hour: lastHour,
      rpm_estimate: Math.round(lastHour / 60 * 10) / 10,
      unique_agents_today: uniqueAgents,
    },
    resources_provisioned: {
      agents: totalAgents,
      phones: totalPhones,
      emails: totalEmails,
      servers: totalServers,
    },
    top_endpoints: topEndpoints.slice(0, 10).map((e: any) => ({
      path: e.path,
      hits: e.hits,
    })),
    uptime: {
      process_hours: Math.round(process.uptime() / 3600 * 10) / 10,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    },
    links: {
      docs: "http://77.42.89.233:3001/docs",
      health: "http://77.42.89.233:3001/api/health",
      github: "https://github.com/0xArtex/AgentOS",
    },
  });
});

export default router;
