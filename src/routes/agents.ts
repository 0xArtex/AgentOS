import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { db } from "../db";

const router = Router({ mergeParams: true });

/**
 * POST /agents/register — Register a new agent (free, gets an agent token)
 *
 * This is the auth on-ramp: the token issued here is what every other
 * (non-payment) route validates via `SELECT * FROM agents WHERE token = ?`
 * in middleware/auth.ts. The token MUST carry the `aos_` prefix that auth
 * accepts (`apiKey.startsWith("aos_") || apiKey.startsWith("agt_")`).
 *
 * The whole body is wrapped in try/catch: a synchronous throw inside an async
 * Express handler becomes an unhandled rejection that Express can't catch, so
 * the request would hang until the client times out. Catching it ourselves
 * guarantees a clean JSON error instead.
 */
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, description, walletAddress, webhookUrl } = req.body ?? {};

    // Wallet address is REQUIRED
    if (!walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      res.status(400).json({
        error: "Wallet Address Required",
        message: "Provide a valid Solana wallet address (base58 public key)",
        hint: "Your wallet is your identity. Include 'walletAddress' in your request body.",
      });
      return;
    }

    if (!name || typeof name !== "string" || name.length < 2) {
      res.status(400).json({
        error: "Invalid Agent Name",
        message: "Agent name must be at least 2 characters",
        hint: "Provide a 'name' field in your request body",
      });
      return;
    }

    // Check if wallet already registered
    const existingWallet = db.prepare("SELECT id, name FROM agents WHERE wallet_address = ?").get(walletAddress) as any;
    if (existingWallet) {
      res.status(409).json({
        error: "Wallet Already Registered",
        message: `This wallet is already registered as agent '${existingWallet.name}'`,
        hint: "Use your existing token, or use a different wallet.",
      });
      return;
    }

    // Check if name is taken
    const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(name);
    if (existing) {
      res.status(409).json({
        error: "Agent Name Taken",
        message: `An agent named '${name}' already exists`,
        hint: "Choose a different name",
      });
      return;
    }

    const id = `agent_${Date.now()}_${randomBytes(4).toString("hex")}`;
    // CSPRNG token in the `aos_` format middleware/auth.ts validates. 48 hex
    // chars (24 random bytes) matches the length of existing live tokens.
    const token = `aos_${randomBytes(24).toString("hex")}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO agents (id, name, description, wallet_address, webhook_url, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name, description || null, walletAddress, webhookUrl || null, token, now);

    res.status(201).json({
      agent: {
        id,
        name,
        walletAddress,
        createdAt: now,
      },
      token,
      warning: "⚠️ Save your token — it is shown once and cannot be recovered.",
      nextSteps: [
        "Use your token: Authorization: Bearer " + token,
        "Pay with USDC for services (x402) — your wallet is your identity",
        "Check your profile: GET /agents/" + id,
      ],
    });
  } catch (err: any) {
    res.status(500).json({
      error: "Registration Failed",
      message: err?.message ?? "Could not register agent",
    });
  }
});


/**
 * GET /agents/search?q=name — Search agents by name/description
 */
router.get("/search", (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) {
    res.status(400).json({
      error: "Invalid Query",
      message: "Search query must be at least 2 characters",
      hint: "GET /agents/search?q=myagent",
    });
    return;
  }

  const agents = db
    .prepare(
      `SELECT id, name, description, created_at FROM agents 
       WHERE name LIKE ? OR description LIKE ?
       LIMIT 20`
    )
    .all(`%${q}%`, `%${q}%`);

  res.json({ query: q, results: agents, count: agents.length });
});

/**
 * GET /agents/:id — Get agent profile and usage stats
 */
router.get("/:id", (req: Request, res: Response) => {
  const agent = db
    .prepare(
      "SELECT id, name, description, wallet_address, webhook_url, created_at FROM agents WHERE id = ?"
    )
    .get(req.params.id) as any;

  if (!agent) {
    res.status(404).json({
      error: "Agent Not Found",
      message: `No agent with id '${req.params.id}'`,
      hint: "Check the agent ID or register a new agent at POST /agents/register",
    });
    return;
  }

  // Get resource counts
  const phoneCount = (
    db.prepare("SELECT COUNT(*) as c FROM phone_numbers WHERE owner = ?").get(agent.id) as any
  ).c;
  const emailCount = (
    db.prepare("SELECT COUNT(*) as c FROM email_inboxes WHERE owner = ?").get(agent.id) as any
  ).c;
  const serverCount = (
    db.prepare("SELECT COUNT(*) as c FROM servers WHERE owner = ?").get(agent.id) as any
  ).c;
  const domainCount = (
    db.prepare("SELECT COUNT(*) as c FROM domains WHERE owner = ?").get(agent.id) as any
  ).c;

  // Get recent activity
  const recentSms = (
    db.prepare(
      `SELECT COUNT(*) as c FROM sms_messages sm 
       JOIN phone_numbers pn ON sm.phone_number_id = pn.id 
       WHERE pn.owner = ? AND sm.timestamp > datetime('now', '-24 hours')`
    ).get(agent.id) as any
  ).c;

  const recentEmails = (
    db.prepare(
      `SELECT COUNT(*) as c FROM email_messages em 
       JOIN email_inboxes ei ON em.inbox_id = ei.id 
       WHERE ei.owner = ? AND em.timestamp > datetime('now', '-24 hours')`
    ).get(agent.id) as any
  ).c;

  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      walletAddress: agent.wallet_address,
      webhookUrl: agent.webhook_url,
      createdAt: agent.created_at,
    },
    resources: {
      phoneNumbers: phoneCount,
      emailInboxes: emailCount,
      servers: serverCount,
      domains: domainCount,
    },
    activity24h: {
      smsMessages: recentSms,
      emailMessages: recentEmails,
    },
  });
});


/**
 * GET /agents/search?q=name — Search agents by name/description
 */

/**
 * GET /agents/:id/resources — List all resources owned by an agent
 */
router.get("/:id/resources", (req: Request, res: Response) => {
  const agentId = req.params.id;

  const phones = db
    .prepare("SELECT id, phone_number, country, provisioned_at, active FROM phone_numbers WHERE owner = ?")
    .all(agentId);
  const emails = db
    .prepare("SELECT id, address, created_at, active FROM email_inboxes WHERE owner = ?")
    .all(agentId);
  const servers = db
    .prepare("SELECT id, name, server_type, status, ipv4, created_at FROM servers WHERE owner = ?")
    .all(agentId);
  const domains = db
    .prepare("SELECT id, domain, status, registered_at, expires_at FROM domains WHERE owner = ?")
    .all(agentId);

  res.json({
    agentId,
    resources: {
      phoneNumbers: phones,
      emailInboxes: emails,
      servers,
      domains,
    },
    totals: {
      phoneNumbers: phones.length,
      emailInboxes: emails.length,
      servers: servers.length,
      domains: domains.length,
    },
  });
});

/**
 * GET /agents/leaderboard — Top agents by resource usage
 */
router.get("/", (req: Request, res: Response) => {
  // If query has leaderboard=true, show leaderboard
  if (req.query.leaderboard === "true") {
    const agents = db
      .prepare(
        `SELECT a.id, a.name, a.created_at,
         (SELECT COUNT(*) FROM phone_numbers WHERE owner = a.id) as phones,
         (SELECT COUNT(*) FROM email_inboxes WHERE owner = a.id) as emails,
         (SELECT COUNT(*) FROM servers WHERE owner = a.id) as servers,
         (SELECT COUNT(*) FROM domains WHERE owner = a.id) as domains
         FROM agents a
         ORDER BY (phones + emails + servers + domains) DESC
         LIMIT 20`
      )
      .all();

    res.json({ leaderboard: agents });
    return;
  }

  // Default: list agents
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;

  const agents = db
    .prepare("SELECT id, name, description, created_at FROM agents LIMIT ? OFFSET ?")
    .all(limit, offset);
  const total = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;

  res.json({ agents, total, limit, offset });
});

export default router;