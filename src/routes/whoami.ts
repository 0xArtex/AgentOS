import { Router } from "express";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/whoami:
 *   get:
 *     summary: Agent identity check
 *     description: Returns your agent identity, usage stats, and provisioned resources based on your X-Agent-Id header
 *     tags: [Agent]
 *     parameters:
 *       - in: header
 *         name: X-Agent-Id
 *         schema:
 *           type: string
 *         required: true
 *         description: Your agent identifier
 *     responses:
 *       200:
 *         description: Agent identity and stats
 *       401:
 *         description: Missing X-Agent-Id header
 */
router.get("/", (req, res) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) {
    return res.status(401).json({
      error: "Missing X-Agent-Id header",
      hint: "Include X-Agent-Id: your-agent-name in your request headers"
    });
  }

  // Check if agent exists
  const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as any;

  // Get usage stats
  let requestCount = 0;
  let lastSeen = null;
  try {
    const stats = db.prepare(
      "SELECT COUNT(*) as c, MAX(timestamp) as last FROM request_log WHERE agent_id = ?"
    ).get(agentId) as any;
    requestCount = stats?.c || 0;
    lastSeen = stats?.last || null;
  } catch {}

  // Get provisioned resources
  let phones: any[] = [];
  let emails: any[] = [];
  let servers: any[] = [];
  try {
    phones = db.prepare("SELECT phone_number, created_at FROM phones WHERE agent_id = ?").all(agentId) as any[];
    emails = db.prepare("SELECT address, created_at FROM emails WHERE agent_id = ?").all(agentId) as any[];
    servers = db.prepare("SELECT server_id, status, created_at FROM servers WHERE agent_id = ?").all(agentId) as any[];
  } catch {}

  // Hackathon status
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    agent_id: agentId,
    registered: !!agent,
    created_at: agent?.created_at || null,
    stats: {
      total_requests: requestCount,
      last_seen: lastSeen
    },
    resources: {
      phones: phones.length,
      emails: emails.length,
      servers: servers.length,
      phone_list: phones,
      email_list: emails,
      server_list: servers
    },
    hackathon: {
      mode: "FREE",
      deadline: deadline.toISOString(),
      hours_remaining: Math.round(hoursLeft * 10) / 10,
      note: hoursLeft > 0
        ? `${Math.round(hoursLeft)} hours left — build fast!`
        : "Hackathon ended"
    }
  });
});

export default router;
