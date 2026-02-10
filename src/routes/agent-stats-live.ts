import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/agent-stats — real-time platform statistics with live DB queries
router.get("/", (_req: Request, res: Response) => {
  
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  // Live DB counts
  const safeCount = (table: string): number => {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
      return row?.c || 0;
    } catch { return 0; }
  };

  const agents = safeCount("agents");
  const phones = safeCount("phones");
  const emails = safeCount("emails");
  const servers = safeCount("servers");
  const domains = safeCount("domains");
  const webhooks = safeCount("webhooks");
  const escrows = safeCount("escrows");
  const tasks = safeCount("tasks");
  const logs = safeCount("agent_logs");
  const invoices = safeCount("invoices");
  const collaborations = safeCount("collaborations");
  const notifications = safeCount("notifications");
  const ratings = safeCount("agent_ratings");

  // Request stats
  const totalRequests = safeCount("request_log");
  const last24h = (() => {
    try {
      const row = db.prepare(
        "SELECT COUNT(*) as c FROM request_log WHERE timestamp > datetime(now, -24 hours)"
      ).get() as any;
      return row?.c || 0;
    } catch { return 0; }
  })();

  // Memory
  const mem = process.memoryUsage();

  res.json({
    title: "AgentOS — Live Platform Statistics",
    generated_at: now.toISOString(),
    hackathon: {
      hours_remaining: Math.round(hoursLeft * 10) / 10,
      deadline: deadline.toISOString(),
      status: hoursLeft > 24 ? "building" : hoursLeft > 6 ? "crunch" : hoursLeft > 0 ? "final-sprint" : "submitted"
    },
    resources: {
      agents_registered: agents,
      phones_provisioned: phones,
      emails_configured: emails,
      compute_instances: servers,
      domains_registered: domains,
      webhooks_active: webhooks,
      escrows_created: escrows,
      tasks_queued: tasks,
      logs_recorded: logs,
      invoices_generated: invoices,
      collaborations: collaborations,
      notifications_sent: notifications,
      peer_ratings: ratings
    },
    traffic: {
      total_api_requests: totalRequests,
      last_24h_requests: last24h,
      requests_per_hour: Math.round(last24h / 24)
    },
    system: {
      memory_rss_mb: Math.round(mem.rss / 1048576),
      heap_used_mb: Math.round(mem.heapUsed / 1048576),
      uptime_hours: Math.round(process.uptime() / 36) / 100,
      node_version: process.version
    },
    links: {
      docs: "http://77.42.89.233:3001/docs",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/AgentOS"
    }
  });
});

export default router;
