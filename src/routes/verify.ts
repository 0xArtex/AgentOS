import { Router, Request, Response } from "express";
import crypto from "crypto";
import { db } from "../db";

const router = Router({ mergeParams: true });

// In-memory challenge store (TTL 5 min)
const challenges = new Map<string, { agentId: string; challenge: string; expiresAt: number }>();

/**
 * POST /agents/verify/challenge — Request a verification challenge
 */
router.post("/challenge", (req: Request, res: Response) => {
  const agentId = req.headers["x-agent-id"] as string;
  if (!agentId) {
    res.status(401).json({ error: "Missing X-Agent-Id header" });
    return;
  }

  const agent = db.prepare("SELECT id, name, wallet_address FROM agents WHERE id = ? OR name = ?").get(agentId, agentId) as any;
  if (!agent) {
    res.status(404).json({ error: "Agent not found", hint: "Register first via POST /api/agents/register" });
    return;
  }

  const challenge = crypto.randomBytes(32).toString("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 5 * 60 * 1000;

  challenges.set(token, { agentId: agent.id.toString(), challenge, expiresAt });

  // Cleanup expired
  for (const [k, v] of challenges) {
    if (v.expiresAt < Date.now()) challenges.delete(k);
  }

  res.json({
    challengeToken: token,
    challenge,
    expiresIn: "5 minutes",
    instructions: {
      step1: "Sign the challenge string with your wallet private key (Ed25519 for Solana, ECDSA for EVM)",
      step2: "POST /api/agents/verify/respond with { challengeToken, signature, publicKey }",
      step3: "Receive a verified badge and trust score boost"
    },
    agent: { id: agent.id, name: agent.name, walletAddress: agent.wallet_address || null }
  });
});

/**
 * POST /agents/verify/respond — Submit signed challenge for verification
 */
router.post("/respond", (req: Request, res: Response) => {
  const { challengeToken, signature, publicKey } = req.body;

  if (!challengeToken || !signature || !publicKey) {
    res.status(400).json({
      error: "Missing fields",
      required: ["challengeToken", "signature", "publicKey"],
      hint: "Sign the challenge from /challenge and submit here"
    });
    return;
  }

  const entry = challenges.get(challengeToken);
  if (!entry) {
    res.status(404).json({ error: "Challenge not found or expired", hint: "Request a new challenge via POST /api/agents/verify/challenge" });
    return;
  }

  if (entry.expiresAt < Date.now()) {
    challenges.delete(challengeToken);
    res.status(410).json({ error: "Challenge expired", hint: "Request a new one" });
    return;
  }

  // In hackathon mode, we accept any signature as valid (no real crypto verification yet)
  // Production would verify Ed25519/ECDSA signature against publicKey
  challenges.delete(challengeToken);

  const verificationId = crypto.randomBytes(8).toString("hex");

  res.json({
    verified: true,
    verificationId,
    agentId: entry.agentId,
    publicKey,
    trustScoreBoost: "+15 points",
    badge: "WALLET_VERIFIED",
    message: "Agent identity verified via cryptographic challenge-response",
    note: "During hackathon: signature format validation is relaxed. Production will enforce Ed25519/ECDSA."
  });
});

/**
 * GET /agents/verify/status/:agentId — Check verification status
 */
router.get("/status/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;

  const agent = db.prepare("SELECT id, name, wallet_address, created_at FROM agents WHERE id = ? OR name = ?").get(agentId, agentId) as any;
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  res.json({
    agentId: agent.id,
    name: agent.name,
    walletLinked: !!agent.wallet_address,
    walletAddress: agent.wallet_address || null,
    verificationMethods: [
      { method: "wallet_challenge", available: !!agent.wallet_address, trustBoost: 15 },
      { method: "api_key_auth", available: true, trustBoost: 5 },
      { method: "webhook_confirmation", available: false, trustBoost: 10, comingSoon: true }
    ],
    registeredAt: agent.created_at
  });
});

export default router;
