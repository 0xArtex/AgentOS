import { Router, Request, Response } from "express";
import crypto from "crypto";
import { db } from "../db";

const router = Router();

// did:palmyr is a deterministic, derived identifier — NOT an authoritative
// registry record. We never invent trust scores or "verified" status here; real
// verification lives at POST /api/agents/verify/* (signature challenge-response).
function didFor(id: string): string {
  return `did:palmyr:${id}`;
}

router.get("/", (_req: Request, res: Response) => {
  res.json({
    endpoint: "/api/agent-identity",
    description: "Derived agent identity helper. DIDs are deterministically derived from your identifier; they are not an authoritative trust registry.",
    routes: {
      "POST /create": "Derive a DID for a name (not persisted)",
      "GET /:agentId": "Resolve real registration data for an agent id/name/wallet",
      "POST /:agentId/verify": "Get a one-time challenge to sign (complete via /api/agents/verify)",
      "POST /:agentId/claim": "Describe an external claim you intend to verify"
    },
    verification: "Real wallet verification: POST /api/agents/verify/challenge then /respond"
  });
});

// Derive a DID for a chosen name. This does NOT persist anything and confers no
// trust — it just returns a deterministic identifier the caller can adopt.
router.post("/create", (req: Request, res: Response) => {
  const { name, description, capabilities } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.status(201).json({
    success: true,
    persisted: false,
    note: "Derived identity only. Register via POST /api/agents/register to persist, and verify a wallet via POST /api/agents/verify.",
    identity: {
      id: agentId,
      did: didFor(agentId),
      name,
      description: description || null,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      claims: []
    }
  });
});

// Resolve REAL registration data only. No fabricated trust_score / "active"
// status — if the agent isn't registered we say so plainly.
router.get("/:agentId", (req: Request, res: Response) => {
  const id = String(req.params.agentId);
  const agent = db.prepare(
    "SELECT id, name, wallet_address, created_at FROM agents WHERE id = ? OR name = ? OR wallet_address = ?"
  ).get(id, id, id) as any;

  if (!agent) {
    return res.json({
      id,
      did: didFor(id),
      registered: false,
      note: "No registered agent matches this identifier. did is derived, not authoritative."
    });
  }

  res.json({
    id: agent.id,
    did: didFor(String(agent.id)),
    registered: true,
    name: agent.name,
    walletLinked: !!agent.wallet_address,
    walletAddress: agent.wallet_address || null,
    walletVerified: false,
    registeredAt: agent.created_at,
    note: "walletLinked reflects a stored address; it is NOT proof of control. Verify via POST /api/agents/verify."
  });
});

// Issue a one-time challenge string. Signing it proves nothing here; the caller
// must complete verification at the real signature-checking endpoint.
router.post("/:agentId/verify", (req: Request, res: Response) => {
  const challenge = crypto.randomBytes(16).toString("hex");
  res.json({
    agentId: req.params.agentId,
    challenge,
    expires: new Date(Date.now() + 300000).toISOString(),
    instructions: "Sign this challenge with your wallet key, then submit it to POST /api/agents/verify/respond (which actually checks the signature).",
    verifyEndpoint: "/api/agents/verify/respond"
  });
});

// Record the *intent* to verify an external claim. It is explicitly unverified.
router.post("/:agentId/claim", (req: Request, res: Response) => {
  const { type, value } = req.body || {};
  const valid = ["x_handle", "github", "domain", "solana_wallet"];
  if (!type || !valid.includes(type)) return res.status(400).json({ error: `type must be: ${valid.join(", ")}` });
  if (!value) return res.status(400).json({ error: "value required" });
  res.json({ success: true, persisted: false, claim: { type, value, status: "unverified" } });
});

export default router;
