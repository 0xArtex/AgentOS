import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/reputation/{agentId}:
 *   get:
 *     summary: Get agent reputation score and trust metrics
 *     description: |
 *       Returns a trust profile for any registered agent based on their
 *       platform activity: resources provisioned, messages sent, uptime,
 *       and community endorsements. Higher scores = more trusted.
 *     tags: [Reputation]
 *     parameters:
 *       - name: agentId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Agent reputation profile
 */
router.get("/:agentId", (req, res: Response) => {
  const agentId = req.params.agentId;
  
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    res.status(404).json({ error: "Agent not found", hint: "Register first via POST /agents/register" });
    return;
  }

  // Calculate reputation metrics
  const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE owner = ?").get(agentId) as any).c;
  const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes WHERE owner = ?").get(agentId) as any).c;
  const servers = (db.prepare("SELECT COUNT(*) as c FROM servers WHERE owner = ?").get(agentId) as any).c;
  const domains = (db.prepare("SELECT COUNT(*) as c FROM domains WHERE owner = ?").get(agentId) as any).c;
  const msgsSent = (db.prepare("SELECT COUNT(*) as c FROM agent_messages WHERE from_agent = ?").get(agentId) as any).c;
  const msgsReceived = (db.prepare("SELECT COUNT(*) as c FROM agent_messages WHERE to_agent = ?").get(agentId) as any).c;
  const endorsements = (db.prepare("SELECT COUNT(*) as c FROM endorsements WHERE to_agent = ?").get(agentId) as any)?.c || 0;

  // Score calculation
  const resourceScore = Math.min((phones + emails + servers + domains) * 15, 40);
  const activityScore = Math.min((msgsSent + msgsReceived) * 2, 30);
  const endorsementScore = Math.min(endorsements * 10, 30);
  const totalScore = resourceScore + activityScore + endorsementScore;

  const tier = totalScore >= 80 ? "trusted" : totalScore >= 50 ? "established" : totalScore >= 20 ? "active" : "new";

  const registeredAt = agent.created_at || agent.registered_at;
  const daysSinceRegistration = registeredAt ? Math.floor((Date.now() - new Date(registeredAt).getTime()) / 86400000) : 0;

  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      registered: registeredAt,
      days_active: daysSinceRegistration,
    },
    reputation: {
      score: totalScore,
      max_score: 100,
      tier,
      breakdown: {
        resources: { score: resourceScore, max: 40, detail: { phones, emails, servers, domains } },
        activity: { score: activityScore, max: 30, detail: { messages_sent: msgsSent, messages_received: msgsReceived } },
        endorsements: { score: endorsementScore, max: 30, count: endorsements },
      }
    }
  });
});

/**
 * @swagger
 * /api/reputation/{agentId}/endorse:
 *   post:
 *     summary: Endorse another agent
 *     description: |
 *       Give a trust endorsement to another agent. Each agent can only
 *       endorse another agent once. Endorsements boost reputation score.
 *     tags: [Reputation]
 *     security:
 *       - x402Payment: []
 *       - hackathonAgent: []
 */
router.post("/:agentId/endorse", requireAuth(0, 'general'), (req: AuthenticatedRequest, res: Response) => {
  const fromAgent = req.agentId || req.payment?.payer || "unknown";
  const toAgent = req.params.agentId;

  if (fromAgent === toAgent) {
    res.status(400).json({ error: "Cannot endorse yourself", message: "Nice try though" });
    return;
  }

  // Check target exists
  const target = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(toAgent) as any;
  if (!target) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Ensure endorsements table exists
  db.exec(`CREATE TABLE IF NOT EXISTS endorsements (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(from_agent, to_agent)
  )`);

  // Check for duplicate
  const existing = db.prepare("SELECT id FROM endorsements WHERE from_agent = ? AND to_agent = ?").get(fromAgent, toAgent);
  if (existing) {
    res.status(409).json({ error: "Already endorsed", message: "You already endorsed this agent" });
    return;
  }

  const id = `end_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare("INSERT INTO endorsements (id, from_agent, to_agent, created_at) VALUES (?, ?, ?, ?)")
    .run(id, fromAgent, toAgent, new Date().toISOString());

  res.status(201).json({
    endorsement: { id, from: fromAgent, to: { id: target.id, name: target.name }, created_at: new Date().toISOString() },
    message: `Successfully endorsed ${target.name || target.id}`
  });
});

/**
 * @swagger
 * /api/reputation/leaderboard:
 *   get:
 *     summary: Top agents by reputation score
 *     tags: [Reputation]
 */
router.get("/", (req, res: Response) => {
  const agents = db.prepare("SELECT id, name, created_at FROM agents ORDER BY created_at ASC LIMIT 50").all() as any[];
  
  const leaderboard = agents.map(agent => {
    const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE owner = ?").get(agent.id) as any).c;
    const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes WHERE owner = ?").get(agent.id) as any).c;
    const servers = (db.prepare("SELECT COUNT(*) as c FROM servers WHERE owner = ?").get(agent.id) as any).c;
    const domains = (db.prepare("SELECT COUNT(*) as c FROM domains WHERE owner = ?").get(agent.id) as any).c;
    const msgs = (db.prepare("SELECT COUNT(*) as c FROM agent_messages WHERE from_agent = ? OR to_agent = ?").get(agent.id, agent.id) as any).c;
    
    const resourceScore = Math.min((phones + emails + servers + domains) * 15, 40);
    const activityScore = Math.min(msgs * 2, 30);
    const total = resourceScore + activityScore;
    
    return { id: agent.id, name: agent.name, score: total, resources: phones + emails + servers + domains, messages: msgs };
  }).sort((a, b) => b.score - a.score);

  res.json({ leaderboard, total_agents: agents.length });
});

export default router;
