import { Router } from "express";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/agent-activity:
 *   get:
 *     summary: Real-time agent activity feed
 *     description: Shows recent API usage, registrations, and resource provisioning across all agents. Live proof the platform is being used.
 *     tags: [Analytics]
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           default: 24
 *         description: Lookback window in hours
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Max events to return
 *     responses:
 *       200:
 *         description: Activity feed with stats
 */
router.get("/", (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 24, 168);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  // Recent requests
  let recentRequests: any[] = [];
  try {
    recentRequests = db.prepare(`
      SELECT agent_id, method, path, status_code, timestamp
      FROM request_log
      WHERE timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(since, limit);
  } catch {}

  // Per-agent breakdown
  let agentBreakdown: any[] = [];
  try {
    agentBreakdown = db.prepare(`
      SELECT agent_id, COUNT(*) as total_requests,
        COUNT(DISTINCT path) as unique_endpoints,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM request_log
      WHERE agent_id IS NOT NULL AND timestamp > ?
      GROUP BY agent_id
      ORDER BY total_requests DESC
      LIMIT 20
    `).all(since);
  } catch {}

  // Endpoint popularity
  let endpointPopularity: any[] = [];
  try {
    endpointPopularity = db.prepare(`
      SELECT path, method, COUNT(*) as hits
      FROM request_log
      WHERE timestamp > ?
      GROUP BY path, method
      ORDER BY hits DESC
      LIMIT 15
    `).all(since);
  } catch {}

  // Hourly traffic
  let hourlyTraffic: any[] = [];
  try {
    hourlyTraffic = db.prepare(`
      SELECT strftime(%Y-%m-%dT%H:00:00Z, timestamp) as hour, COUNT(*) as requests
      FROM request_log
      WHERE timestamp > ?
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT 24
    `).all(since);
  } catch {}

  // Registration timeline
  let registrations: any[] = [];
  try {
    registrations = db.prepare(`
      SELECT id, name, created_at FROM agents
      ORDER BY created_at DESC LIMIT 10
    `).all();
  } catch {}

  res.json({
    window: { hours, since, until: new Date().toISOString() },
    summary: {
      total_requests: recentRequests.length >= limit ? `${limit}+` : recentRequests.length,
      active_agents: agentBreakdown.length,
      top_endpoint: endpointPopularity[0]?.path || "N/A",
    },
    agent_breakdown: agentBreakdown,
    endpoint_popularity: endpointPopularity,
    hourly_traffic: hourlyTraffic,
    recent_registrations: registrations,
    recent_requests: recentRequests.slice(0, 20),
  });
});

export default router;
