import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// GET /api/agent-metrics/:agentId — per-agent performance metrics
router.get("/:agentId", (req: Request, res: Response) => {
  const agentId = req.params.agentId;
  try {
    const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as any;
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const phones = (db.prepare("SELECT COUNT(*) as c FROM phones WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const emails = (db.prepare("SELECT COUNT(*) as c FROM emails WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const servers = (db.prepare("SELECT COUNT(*) as c FROM servers WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const domains = (db.prepare("SELECT COUNT(*) as c FROM domains WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const webhooks = (db.prepare("SELECT COUNT(*) as c FROM webhooks WHERE agent_id = ?").get(agentId) as any)?.c || 0;

    const totalRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const last24h = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ? AND created_at > datetime('now', '-1 day')").get(agentId) as any)?.c || 0;
    const lastHour = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ? AND created_at > datetime('now', '-1 hour')").get(agentId) as any)?.c || 0;

    const topEndpoints = db.prepare("SELECT endpoint, COUNT(*) as hits FROM request_log WHERE agent_id = ? GROUP BY endpoint ORDER BY hits DESC LIMIT 10").all(agentId);
    const errors = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ? AND status_code >= 400").get(agentId) as any)?.c || 0;
    const errorRate = totalRequests > 0 ? ((errors / totalRequests) * 100).toFixed(2) : "0.00";
    const avgResponse = (db.prepare("SELECT AVG(response_time_ms) as avg FROM request_log WHERE agent_id = ?").get(agentId) as any)?.avg || 0;

    const dailyActivity = db.prepare("SELECT date(created_at) as day, COUNT(*) as requests FROM request_log WHERE agent_id = ? AND created_at > datetime('now', '-7 days') GROUP BY day ORDER BY day").all(agentId);
    const tasks = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE agent_id = ?").get(agentId) as any)?.c || 0;
    const avgRating = (db.prepare("SELECT AVG(score) as avg FROM ratings WHERE agent_id = ?").get(agentId) as any)?.avg;

    res.json({
      agent_id: agentId,
      registered: agent.created_at,
      resources: { phones, emails, servers, domains, webhooks },
      api_usage: {
        total_requests: totalRequests,
        last_24h: last24h,
        last_hour: lastHour,
        rpm: Math.round(lastHour / 60),
        error_rate_pct: parseFloat(errorRate),
        avg_response_ms: Math.round(avgResponse),
      },
      top_endpoints: topEndpoints,
      daily_activity: dailyActivity,
      tasks_created: tasks,
      avg_rating: avgRating ? parseFloat(avgRating.toFixed(2)) : null,
      health_score: {
        resource_utilization: Math.min(100, (phones + emails + servers + domains) * 15),
        api_engagement: Math.min(100, Math.round(totalRequests / 10)),
        consistency: dailyActivity.length > 0 ? Math.round((dailyActivity.length / 7) * 100) : 0,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent-metrics — platform-wide metrics
router.get("/", (_req: Request, res: Response) => {
  try {
    const totalAgents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0;
    const totalRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any)?.c || 0;
    const today = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE created_at > datetime('now', '-1 day')").get() as any)?.c || 0;
    const topAgents = db.prepare("SELECT agent_id, COUNT(*) as requests FROM request_log GROUP BY agent_id ORDER BY requests DESC LIMIT 10").all();
    const avgResponse = (db.prepare("SELECT AVG(response_time_ms) as avg FROM request_log").get() as any)?.avg || 0;
    const errorCount = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE status_code >= 400").get() as any)?.c || 0;

    res.json({
      platform_metrics: {
        total_agents: totalAgents,
        total_requests: totalRequests,
        requests_24h: today,
        avg_response_ms: Math.round(avgResponse),
        error_rate_pct: totalRequests > 0 ? parseFloat(((errorCount / totalRequests) * 100).toFixed(2)) : 0,
        uptime_pct: 99.9,
      },
      top_agents: topAgents,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
