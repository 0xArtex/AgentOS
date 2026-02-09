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

export default router;
