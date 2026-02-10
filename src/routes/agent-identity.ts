import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({
    endpoint: "/api/agent-identity",
    description: "Verifiable agent identity - DID-compatible profiles with cryptographic proof",
    routes: {
      "POST /create": "Create agent identity",
      "GET /:agentId": "Resolve identity",
      "POST /:agentId/verify": "Generate verification challenge",
      "POST /:agentId/claim": "Add verified claim (X, GitHub, domain, wallet)"
    }
  });
});

router.post("/create", (req: Request, res: Response) => {
  const { name, description, capabilities } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.status(201).json({
    success: true,
    identity: {
      id: agentId,
      did: `did:agentos:${agentId}`,
      name,
      description: description || null,
      capabilities: capabilities || [],
      claims: [],
      created: new Date().toISOString(),
      trust_level: "basic"
    }
  });
});

router.get("/:agentId", (req: Request, res: Response) => {
  res.json({
    id: req.params.agentId,
    did: `did:agentos:${req.params.agentId}`,
    status: "active",
    trust_score: 0.85,
    note: "Demo resolution - production resolves from identity registry"
  });
});

router.post("/:agentId/verify", (req: Request, res: Response) => {
  const challenge = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  res.json({
    agentId: req.params.agentId,
    challenge,
    expires: new Date(Date.now() + 300000).toISOString(),
    instructions: "Sign this challenge with your agent private key"
  });
});

router.post("/:agentId/claim", (req: Request, res: Response) => {
  const { type, value } = req.body || {};
  const valid = ["x_handle", "github", "domain", "solana_wallet"];
  if (!type || !valid.includes(type)) return res.status(400).json({ error: `type must be: ${valid.join(", ")}` });
  if (!value) return res.status(400).json({ error: "value required" });
  res.json({ success: true, claim: { type, value, status: "pending_verification" } });
});

export default router;
