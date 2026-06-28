import { Router, Response } from "express";
import { db } from "../db";
import { requireAuth } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

const router = Router();

// Identity check must be scoped to a VERIFIED identity, not a raw, forgeable
// X-Agent-Id header (the previous version trusted the header directly and then
// queried columns/tables that don't exist — agents.agent_id, phones, emails —
// so it 500'd on every call and, once "fixed" naively, would have been an IDOR).
// requireAuth(0) authenticates for free and sets req.agentId to the wallet identity.
router.use(requireAuth(0, "general"));

/**
 * @swagger
 * /api/whoami:
 *   get:
 *     summary: Agent identity check
 *     description: Returns the authenticated agent's identity, usage stats, and provisioned resources. Identity is resolved from your verified credentials (token / wallet / x402), not a raw header.
 *     tags: [Agent]
 *     responses:
 *       200:
 *         description: Agent identity and stats
 *       401:
 *         description: Missing or unrecognized credentials
 */
router.get("/", (req: AuthenticatedRequest, res: Response) => {
  const agentId = req.agentId || req.payment?.payer;
  if (!agentId) {
    return res.status(401).json({ error: "authentication required" });
  }

  // Resolve the registered agent row by its verified identity. The schema keys
  // agents by id / name / wallet_address (there is no `agent_id` column).
  const agent = db.prepare(
    "SELECT id, name, wallet_address, created_at FROM agents WHERE wallet_address = ? OR id = ? OR name = ?"
  ).get(agentId, agentId, agentId) as any;

  // Usage stats — request_log is keyed by agent_id and timestamped with
  // created_at (not `timestamp`). Best-effort; absence just yields zeroes.
  let requestCount = 0;
  let lastSeen: string | null = null;
  try {
    const stats = db.prepare(
      "SELECT COUNT(*) as c, MAX(created_at) as last FROM request_log WHERE agent_id = ?"
    ).get(agentId) as any;
    requestCount = stats?.c || 0;
    lastSeen = stats?.last || null;
  } catch {}

  // Provisioned resources are owned by the wallet identity (owner column), and
  // are scoped to the caller so this can never enumerate another agent's
  // numbers/inboxes/servers.
  let phones: any[] = [];
  let emails: any[] = [];
  let servers: any[] = [];
  try {
    phones = db.prepare("SELECT phone_number, country, provisioned_at FROM phone_numbers WHERE owner = ?").all(agentId) as any[];
  } catch {}
  try {
    emails = db.prepare("SELECT address, created_at FROM email_inboxes WHERE owner = ?").all(agentId) as any[];
  } catch {}
  try {
    servers = db.prepare("SELECT id AS server_id, status, created_at FROM servers WHERE owner = ?").all(agentId) as any[];
  } catch {}

  res.json({
    agent_id: agentId,
    registered: !!agent,
    name: agent?.name || null,
    wallet_address: agent?.wallet_address || null,
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
    }
  });
});

export default router;
