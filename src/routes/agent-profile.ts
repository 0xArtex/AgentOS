import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/agent-profile/{agentId}:
 *   get:
 *     summary: Get comprehensive agent profile
 *     description: Returns all resources, activity, and reputation for an agent in one call
 *     tags: [Agents]
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full agent profile
 */
router.get("/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;

  // Get agent info
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) {
    return res.status(404).json({ error: "Agent not found", tip: "Register first via POST /api/agents/register" });
  }

  // Get resources
  let phones: any[] = [], emails: any[] = [], servers: any[] = [], domains: any[] = [], wallets: any[] = [];
  try { phones = db.prepare("SELECT id, number, capabilities FROM phones WHERE agent_id = ?").all(agentId) as any[]; } catch {}
  try { emails = db.prepare("SELECT id, address FROM emails WHERE agent_id = ?").all(agentId) as any[]; } catch {}
  try { servers = db.prepare("SELECT id, specs, status FROM servers WHERE agent_id = ?").all(agentId) as any[]; } catch {}
  try { domains = db.prepare("SELECT id, domain, status FROM domains WHERE agent_id = ?").all(agentId) as any[]; } catch {}
  try { wallets = db.prepare("SELECT id, label, sol_address, base_address, supported_chains FROM agent_wallets WHERE user_id = ?").all(agentId) as any[]; } catch {}

  // Activity count
  let activityCount = 0;
  try { activityCount = (db.prepare("SELECT COUNT(*) as c FROM activity_log WHERE agent_id = ?").get(agentId) as any).c; } catch {}

  const totalResources = phones.length + emails.length + servers.length + domains.length + wallets.length;
  const readinessScore = Math.min(100, totalResources * 20);

  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      createdAt: agent.created_at,
    },
    resources: {
      phones: { count: phones.length, items: phones },
      emails: { count: emails.length, items: emails },
      compute: { count: servers.length, items: servers },
      domains: { count: domains.length, items: domains },
      wallets: { count: wallets.length, items: wallets },
      total: totalResources
    },
    readiness: {
      score: readinessScore,
      tier: readinessScore >= 80 ? "production" : readinessScore >= 40 ? "development" : "starter",
      recommendations: [
        ...(phones.length === 0 ? ["Add a phone: POST /api/phone/provision"] : []),
        ...(emails.length === 0 ? ["Add email: POST /api/email/provision"] : []),
        ...(servers.length === 0 ? ["Add compute: POST /api/compute/provision"] : []),
        ...(wallets.length === 0 ? ["Add wallet: POST /api/wallet/create"] : []),
      ]
    },
    activity: { total: activityCount },
    hackathon: { mode: "FREE", deadline: "2026-02-12T17:00:00Z" }
  });
});

export default router;
