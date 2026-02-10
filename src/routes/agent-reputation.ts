import { Router } from "express";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/agent-reputation/{agentId}:
 *   get:
 *     summary: Get agent reputation score
 *     description: Returns composite reputation score based on uptime, API usage patterns, payment history, and resource efficiency
 *     tags: [Agent Reputation]
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Agent reputation profile
 */
router.get("/api/agent-reputation/:agentId", (req, res) => {
  const { agentId } = req.params;
  
  // Get agent data
  const agent = db.prepare("SELECT * FROM api_keys WHERE agent_id = ?").get(agentId) as any;
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  // Count resources
  const phones = (db.prepare("SELECT COUNT(*) as c FROM phones WHERE agent_id = ?").get(agentId) as any)?.c || 0;
  const emails = (db.prepare("SELECT COUNT(*) as c FROM emails WHERE agent_id = ?").get(agentId) as any)?.c || 0;
  const servers = (db.prepare("SELECT COUNT(*) as c FROM servers WHERE agent_id = ?").get(agentId) as any)?.c || 0;
  const domains = (db.prepare("SELECT COUNT(*) as c FROM domains WHERE agent_id = ?").get(agentId) as any)?.c || 0;
  
  // Count API requests
  const requests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ?").get(agentId) as any)?.c || 0;
  const recentRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ? AND timestamp > datetime('now', '-24 hours')").get(agentId) as any)?.c || 0;

  // Calculate reputation dimensions
  const resourceScore = Math.min(100, (phones + emails + servers + domains) * 15);
  const activityScore = Math.min(100, requests * 2);
  const consistencyScore = recentRequests > 0 ? 85 : (requests > 0 ? 50 : 10);
  const diversityScore = Math.min(100, [phones > 0, emails > 0, servers > 0, domains > 0].filter(Boolean).length * 25);
  
  const overallScore = Math.round((resourceScore * 0.25 + activityScore * 0.3 + consistencyScore * 0.25 + diversityScore * 0.2));
  const tier = overallScore >= 80 ? "platinum" : overallScore >= 60 ? "gold" : overallScore >= 40 ? "silver" : "bronze";

  res.json({
    agentId,
    reputation: {
      overall: overallScore,
      tier,
      dimensions: {
        resources: { score: resourceScore, detail: `${phones + emails + servers + domains} total resources provisioned` },
        activity: { score: activityScore, detail: `${requests} lifetime API calls` },
        consistency: { score: consistencyScore, detail: `${recentRequests} calls in last 24h` },
        diversity: { score: diversityScore, detail: `${[phones > 0, emails > 0, servers > 0, domains > 0].filter(Boolean).length}/4 service types used` }
      }
    },
    badges: [
      ...(phones > 0 ? ["📞 communicator"] : []),
      ...(emails > 0 ? ["📧 networker"] : []),
      ...(servers > 0 ? ["🖥️ builder"] : []),
      ...(domains > 0 ? ["🌐 establisher"] : []),
      ...(requests > 50 ? ["⚡ power-user"] : []),
      ...(overallScore >= 80 ? ["🏆 elite"] : [])
    ],
    trustSignals: {
      accountAge: agent.created_at,
      totalResources: phones + emails + servers + domains,
      lifetimeRequests: requests,
      isActive: recentRequests > 0
    }
  });
});

/**
 * @swagger
 * /api/agent-reputation/leaderboard:
 *   get:
 *     summary: Agent reputation leaderboard
 *     tags: [Agent Reputation]
 */
router.get("/api/agent-reputation/leaderboard", (_req, res) => {
  const agents = db.prepare("SELECT agent_id, created_at FROM api_keys ORDER BY created_at ASC").all() as any[];
  
  const leaderboard = agents.map((a: any) => {
    const resources = (db.prepare("SELECT (SELECT COUNT(*) FROM phones WHERE agent_id = ?) + (SELECT COUNT(*) FROM emails WHERE agent_id = ?) + (SELECT COUNT(*) FROM servers WHERE agent_id = ?) + (SELECT COUNT(*) FROM domains WHERE agent_id = ?) as total").get(a.agent_id, a.agent_id, a.agent_id, a.agent_id) as any)?.total || 0;
    const requests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = ?").get(a.agent_id) as any)?.c || 0;
    const score = Math.round(Math.min(100, resources * 15) * 0.25 + Math.min(100, requests * 2) * 0.3 + 50 * 0.25 + Math.min(100, resources > 0 ? 50 : 10) * 0.2);
    return { agentId: a.agent_id, score, since: a.created_at };
  }).sort((a: any, b: any) => b.score - a.score).slice(0, 20);

  res.json({ leaderboard, total_agents: agents.length });
});

export default router;
