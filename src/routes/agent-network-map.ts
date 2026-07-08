import { Router, Request, Response } from "express";

const router = Router();

interface NetworkNode {
  id: string;
  name: string;
  category: string;
  status: "live" | "in-progress" | "planned";
  url?: string;
}

interface NetworkEdge {
  from: string;
  to: string;
  type: "integration" | "data-flow" | "payment";
  description: string;
}

const nodes: NetworkNode[] = [
  { id: "palmyr", name: "Palmyr", category: "infrastructure", status: "live", url: "https://palmyr.ai" },
  { id: "alphavault", name: "AlphaVault", category: "trading", status: "live", url: "http://162.55.53.160:3000" },
  { id: "slotscribe", name: "SlotScribe", category: "verification", status: "in-progress" },
  { id: "agentlink", name: "AgentLink", category: "marketplace", status: "planned" },
  { id: "solsignal", name: "SolSignal", category: "signals", status: "live" },
  { id: "mutualagent", name: "MutualAgent", category: "insurance", status: "planned" },
  { id: "wunderland", name: "WUNDERLAND", category: "social", status: "in-progress" },
  { id: "identityprism", name: "Identity Prism", category: "identity", status: "planned" },
  { id: "sugarclaw", name: "SugarClawdy", category: "commerce", status: "live" },
  { id: "vex", name: "Vex Capital", category: "trading", status: "planned" },
  { id: "mortem", name: "MORTEM", category: "liveness", status: "live" },
  { id: "heliossyn", name: "HeliosSynerga", category: "defi", status: "in-progress" },
  { id: "agentpay", name: "AgentPay", category: "payments", status: "planned" },
  { id: "laso", name: "Laso Finance", category: "payments", status: "live", url: "https://laso.finance" },
];

const edges: NetworkEdge[] = [
  { from: "palmyr", to: "alphavault", type: "integration", description: "Compute containers + trade execution" },
  { from: "palmyr", to: "slotscribe", type: "data-flow", description: "Operational logs → on-chain anchoring" },
  { from: "palmyr", to: "solsignal", type: "integration", description: "Alert notifications via Palmyr comms" },
  { from: "palmyr", to: "sugarclaw", type: "integration", description: "Commerce infra + payment rails" },
  { from: "palmyr", to: "wunderland", type: "data-flow", description: "Event webhooks → frontend SDK" },
  { from: "palmyr", to: "mutualagent", type: "data-flow", description: "Activity logs → risk scoring" },
  { from: "palmyr", to: "agentlink", type: "integration", description: "Identity + compute for hired agents" },
  { from: "palmyr", to: "vex", type: "integration", description: "Execution infra for autonomous funds" },
  { from: "palmyr", to: "mortem", type: "data-flow", description: "Liveness attestation pipeline" },
  { from: "palmyr", to: "heliossyn", type: "integration", description: "Dedicated compute for arb execution" },
  { from: "palmyr", to: "agentpay", type: "payment", description: "x402 USDC payment composability" },
  { from: "palmyr", to: "laso", type: "payment", description: "Prepaid Visa card issuance via x402 (/cards)" },
  { from: "alphavault", to: "solsignal", type: "data-flow", description: "Trade signals → execution" },
  { from: "slotscribe", to: "mutualagent", type: "data-flow", description: "Verified receipts → insurance claims" },
];

router.get("/", (_req: Request, res: Response) => {
  const stats = {
    totalNodes: nodes.length,
    liveIntegrations: nodes.filter(n => n.status === "live").length,
    inProgress: nodes.filter(n => n.status === "in-progress").length,
    planned: nodes.filter(n => n.status === "planned").length,
    totalEdges: edges.length,
    categories: [...new Set(nodes.map(n => n.category))],
  };

  res.json({
    network: { nodes, edges },
    stats,
    description: "Palmyr ecosystem network map — shows how agents connect through our infrastructure layer",
    note: "Post-hackathon: building toward real integrations. Partner with us: https://palmyr.ai/docs",
    updatedAt: new Date().toISOString(),
  });
});

router.get("/category/:cat", (req: Request, res: Response) => {
  const cat = req.params.cat;
  const filtered = nodes.filter(n => n.category === cat);
  const relatedEdges = edges.filter(e => filtered.some(n => n.id === e.from || n.id === e.to));
  res.json({ category: cat, nodes: filtered, edges: relatedEdges });
});

export default router;
