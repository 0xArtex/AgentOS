import { Router, Response, Request } from "express";
import { db } from "../db";
import { v4 as uuid } from "uuid";

const router = Router();

/**
 * POST /agents/register — Register an agent with Palmyr
 * 
 * Required: walletAddress (Solana base58 public key)
 * Optional: agentId (Colosseum hackathon agent ID for free tier)
 * 
 * Returns an API key for future requests.
 */
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { walletAddress, agentId, name } = req.body;

    if (!walletAddress) {
      res.status(400).json({
        error: "Missing wallet address",
        message: "Provide 'walletAddress' (Solana base58 public key) to register",
        hint: "Your wallet is your identity on Palmyr. All services are tied to it.",
      });
      return;
    }

    // Validate wallet format (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
      res.status(400).json({
        error: "Invalid wallet address",
        message: "Provide a valid Solana base58 public key",
      });
      return;
    }

    // Check if wallet already registered
    const existing = db.prepare("SELECT id, wallet_address, agent_id FROM registered_agents WHERE wallet_address = ?").get(walletAddress) as any;
    if (existing) {
      res.status(409).json({
        error: "Wallet already registered",
        message: "This wallet is already registered with Palmyr",
        agentId: existing.agent_id,
        hint: "Use your existing API key or contact support",
      });
      return;
    }

    // If Colosseum agent ID provided, validate it
    let hackathonVerified = false;
    if (agentId) {
      // Check if this agent ID is already bound to a different wallet
      const existingAgent = db.prepare("SELECT wallet_address FROM registered_agents WHERE agent_id = ?").get(agentId) as any;
      if (existingAgent) {
        res.status(409).json({
          error: "Agent ID already registered",
          message: `Colosseum agent ID "${agentId}" is already bound to a different wallet`,
          hint: "Each Colosseum agent ID can only be linked to one wallet. This prevents free-tier exploitation.",
        });
        return;
      }

      // Verify against Colosseum API
      try {
        const colosseumResp = await fetch(`https://agents.colosseum.com/api/agents/status`, {
          headers: { "Authorization": `Bearer ${agentId}` },
        });
        if (colosseumResp.ok) {
          hackathonVerified = true;
        }
      } catch {
        // Can't reach Colosseum API — allow but mark unverified
        console.warn(`[register] Could not verify Colosseum agent ID: ${agentId}`);
      }
    }

    // Generate API key
    const id = uuid();
    const apiKey = `aos_${uuid().replace(/-/g, "")}`;

    db.prepare(`
      INSERT INTO registered_agents (id, wallet_address, agent_id, name, api_key, hackathon_verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, walletAddress, agentId || null, name || null, apiKey, hackathonVerified ? 1 : 0);

    res.status(201).json({
      id,
      walletAddress,
      agentId: agentId || null,
      hackathonVerified,
      apiKey,
      warning: "⚠️ Save your API key — it is shown once.",
      freeTier: hackathonVerified ? {
        active: true,
        limits: { email: 1, phone: 1, server: 1 },
        note: "Colosseum hackathon participants get 1 free service each. Additional services require USDC payment.",
        expiresAt: "2026-02-12T17:00:00Z",
      } : null,
      paidTier: {
        note: "Pay with USDC on Solana via x402 for unlimited services",
        pricing: "GET /pricing",
      },
    });
  } catch (err: any) {
    console.error("[register] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /agents/me — Get your agent profile
 */
router.get("/me", async (req: Request, res: Response) => {
  const apiKey = req.headers["authorization"]?.replace("Bearer ", "") || req.headers["x-api-key"] as string;
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key. Include Authorization: Bearer <key> or X-Api-Key header." });
    return;
  }

  const agent = db.prepare("SELECT * FROM registered_agents WHERE api_key = ?").get(apiKey) as any;
  if (!agent) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  // Get usage
  const usage = {
    emails: (db.prepare("SELECT COUNT(*) as c FROM hackathon_usage WHERE agent_id = ? AND service_type = 'email'").get(agent.agent_id || agent.wallet_address) as any)?.c || 0,
    phones: (db.prepare("SELECT COUNT(*) as c FROM hackathon_usage WHERE agent_id = ? AND service_type = 'phone'").get(agent.agent_id || agent.wallet_address) as any)?.c || 0,
    servers: (db.prepare("SELECT COUNT(*) as c FROM hackathon_usage WHERE agent_id = ? AND service_type = 'server'").get(agent.agent_id || agent.wallet_address) as any)?.c || 0,
  };

  res.json({
    id: agent.id,
    walletAddress: agent.wallet_address,
    agentId: agent.agent_id,
    name: agent.name,
    hackathonVerified: Boolean(agent.hackathon_verified),
    usage,
    freeTier: agent.hackathon_verified ? { email: 1 - usage.emails, phone: 1 - usage.phones, server: 1 - usage.servers } : null,
    createdAt: agent.created_at,
  });
});

export default router;
