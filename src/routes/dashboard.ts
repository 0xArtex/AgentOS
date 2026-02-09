import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { db } from "../db";

const router = Router();

/**
 * @swagger
 * /api/dashboard:
 *   get:
 *     summary: Agent Dashboard — full account overview
 *     description: |
 *       Returns everything an agent needs in one call: identity, resources,
 *       usage stats, and active services. Your agent's control panel.
 *     tags: [Dashboard]
 *     security:
 *       - x402Payment: []
 *       - hackathonAgent: []
 *     responses:
 *       200:
 *         description: Full dashboard view
 */
router.get("/", requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.isHackathonMode ? req.agentId! : req.payment!.payer;

    const phones = db.prepare("SELECT id, phone_number, country, provisioned_at FROM phone_numbers WHERE owner = ?").all(owner);
    const emails = db.prepare("SELECT id, address, created_at FROM email_inboxes WHERE owner = ?").all(owner);
    const servers = db.prepare("SELECT id, name, status, server_type, ipv4, created_at FROM servers WHERE owner = ?").all(owner);
    const domains = db.prepare("SELECT id, domain, status, registered_at FROM domains WHERE owner = ?").all(owner);

    const smsSent = db.prepare("SELECT COUNT(*) as count FROM sms_messages sm JOIN phone_numbers pn ON sm.phone_number_id = pn.id WHERE pn.owner = ? AND sm.direction = 'outbound'").get(owner) as any;
    const smsReceived = db.prepare("SELECT COUNT(*) as count FROM sms_messages sm JOIN phone_numbers pn ON sm.phone_number_id = pn.id WHERE pn.owner = ? AND sm.direction = 'inbound'").get(owner) as any;

    res.json({
      agent: {
        id: owner,
        hackathon_mode: req.isHackathonMode || false,
      },
      resources: {
        phone_numbers: phones,
        email_inboxes: emails,
        servers: servers,
        domains: domains,
        summary: {
          total_phones: (phones as any[]).length,
          total_emails: (emails as any[]).length,
          total_servers: (servers as any[]).length,
          total_domains: (domains as any[]).length,
        }
      },
      usage: {
        sms_sent: smsSent?.count || 0,
        sms_received: smsReceived?.count || 0,
      },
      links: {
        docs: "http://77.42.89.233:3001/docs",
        skill: "http://77.42.89.233:3001/skill.md",
        github: "https://github.com/0xArtex/AgentOS",
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: "Dashboard Error", message: err.message });
  }
});

export default router;
