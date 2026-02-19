import { Router, Request, Response } from "express";

const router = Router();

// POST /api/agent-discovery/register
router.post("/register", (req: Request, res: Response) => {
  const { agentId, name, description, capabilities, endpoint, categories } = req.body || {};
  if (!agentId || !name) return res.status(400).json({ error: "agentId and name required" });

  res.json({
    registered: true, agentId, name, discoverable: true,
    listing: { name, description: description || "", capabilities: capabilities || [], endpoint: endpoint || null, categories: categories || [], registeredAt: new Date().toISOString(), verified: false, trustScore: 0 },
    nextSteps: ["Provision resources via /api/phones, /api/emails, /api/servers", "Verify identity via /api/agents/verify", "Build trust score through consistent usage"]
  });
});

// GET /api/agent-discovery/search
router.get("/search", (req: Request, res: Response) => {
  const q = (req.query.q as string || "").toLowerCase();
  const category = (req.query.category as string || "").toLowerCase();

  const ecosystem = [
    { name: "VerdictSwarm", category: "Security", capabilities: ["token-scanning", "adversarial-analysis", "multi-ai-verdict"], status: "live" },
    { name: "AirdropAlpha", category: "Security", capabilities: ["x402-scanning", "token-safety", "airdrop-analysis"], status: "live" },
    { name: "SlotScribe", category: "Verification", capabilities: ["cot-anchoring", "flight-recorder", "audit-trail"], status: "live" },
    { name: "Wunderland", category: "Identity", capabilities: ["hexaco-personality", "behavioral-identity", "content-provenance"], status: "live" },
    { name: "SATI", category: "Identity", capabilities: ["blind-feedback", "reputation-scoring", "sas-attestation"], status: "live" },
    { name: "MoltLaunch", category: "Infrastructure", capabilities: ["trust-signals", "agent-registry", "composability-map"], status: "live" },
    { name: "Vex Capital", category: "Trading", capabilities: ["fund-management", "paper-trading", "news-trading"], status: "live" },
    { name: "SIDEX", category: "Trading", capabilities: ["market-analysis", "volume-tracking", "signal-generation"], status: "live" },
    { name: "AgentOS", category: "Infrastructure", capabilities: ["phone", "email", "compute", "domains", "identity", "x402-payments"], status: "live", self: true }
  ];

  let results = ecosystem;
  if (q) results = results.filter((a: any) => a.name.toLowerCase().includes(q) || a.capabilities.some((c: string) => c.includes(q)));
  if (category) results = results.filter((a: any) => a.category.toLowerCase() === category);

  res.json({ query: { q, category }, results, total: results.length, categories: [...new Set(ecosystem.map((a: any) => a.category))] });
});

// GET /api/agent-discovery/capabilities
router.get("/capabilities", (_req: Request, res: Response) => {
  const caps: Record<string, string[]> = {
    Security: ["token-scanning", "adversarial-analysis", "transaction-simulation", "policy-rules"],
    Identity: ["hexaco-personality", "behavioral-identity", "blind-feedback", "reputation-scoring"],
    Trading: ["fund-management", "paper-trading", "market-analysis", "volume-tracking"],
    Infrastructure: ["phone", "email", "compute", "domains", "agent-registry"],
    Payments: ["x402-settlement", "usdc-micropayments", "agent-credit-cards"],
    Verification: ["cot-anchoring", "flight-recorder", "audit-trail"]
  };
  res.json({ capabilities: caps, totalCategories: Object.keys(caps).length, totalCapabilities: Object.values(caps).flat().length });
});

export default router;
