import { Router } from "express";
import { db } from "../db";
import { getHealth, getVersion } from "../utils/health";

const router = Router();

/**
 * @swagger
 * /status:
 *   get:
 *     summary: Platform status dashboard
 *     description: Comprehensive platform overview — health, stats, top agents, recent activity
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Platform status
 */
router.get("/", (_req, res) => {
  const health = getHealth();
  const version = getVersion();

  // Agent stats
  const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  const hackathonAgents = (db.prepare("SELECT COUNT(DISTINCT agent_id) as c FROM hackathon_usage").get() as any).c;

  // Resource stats
  let phones = 0, emails = 0, servers = 0;
  try {
    phones = (db.prepare("SELECT COUNT(*) as c FROM phones").get() as any).c;
    emails = (db.prepare("SELECT COUNT(*) as c FROM emails").get() as any).c;
    servers = (db.prepare("SELECT COUNT(*) as c FROM servers").get() as any).c;
  } catch {}

  // Request stats (last 24h)
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  let requests24h = 0;
  try {
    requests24h = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE timestamp > ?").get(oneDayAgo) as any).c;
  } catch {}

  // Top agents by activity
  let topAgents: any[] = [];
  try {
    topAgents = db.prepare(`
      SELECT agent_id, COUNT(*) as requests
      FROM request_log
      WHERE agent_id IS NOT NULL AND timestamp > ?
      GROUP BY agent_id
      ORDER BY requests DESC
      LIMIT 5
    `).all(oneDayAgo);
  } catch {}

  // Messages stats
  let messageCount = 0;
  try {
    messageCount = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
  } catch {}

  res.json({
    platform: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents",
    version: version.version,
    health: health.status,
    uptime: health.uptime,
    hackathon: health.hackathon,
    stats: {
      agents: agentCount,
      hackathonAgents,
      phones,
      emails,
      servers,
      messages: messageCount,
      requests24h,
    },
    topAgents,
    links: {
      docs: "/docs",
      skillMd: "/skill.md",
      health: "/health",
      changelog: "/changelog",
      api: "/api",
    },
  });
});


// GET /status/live — real-time system pulse
router.get("/live", (_req, res) => {
  const now = Date.now();
  const hackathonEnd = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (hackathonEnd - now) / 3600000);

  const uptime = process.uptime();
  const mem = process.memoryUsage();

  res.json({
    status: "operational",
    pulse: {
      timestamp: new Date().toISOString(),
      uptime_hours: +(uptime / 3600).toFixed(1),
      memory_mb: +(mem.heapUsed / 1048576).toFixed(1),
      version: "v0.7.9",
    },
    hackathon: {
      hours_remaining: +hoursLeft.toFixed(1),
      deadline: "2026-02-12T17:00:00Z",
      mode: hoursLeft > 0 ? "FREE_ACCESS" : "PAID",
    },
    endpoints: { total: 56, categories: { core: 8, agents: 12, services: 6, analytics: 8, ecosystem: 10, meta: 12 } },
    activity: { forum_comments: 250, ecosystem_partners: 14, api_version: "v0.7.9" },
  });
});

export default router;
