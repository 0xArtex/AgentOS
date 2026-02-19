import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const nodes = [
    { id: "agentos", label: "AgentOS", type: "core", status: "live", services: ["phone", "email", "compute", "domains", "storage", "analytics"] },
    { id: "agent-casino", label: "Agent Casino", type: "partner", status: "live", integration: "x402 payments + compute" },
    { id: "slotscribe", label: "SlotScribe", type: "partner", status: "live", integration: "audit logs + on-chain anchoring" },
    { id: "sugarclaw", label: "SugarClawdy", type: "partner", status: "live", integration: "task marketplace + notifications" },
    { id: "solsignal", label: "SolSignal", type: "partner", status: "live", integration: "signal alerts + comms" },
    { id: "identity-prism", label: "Identity Prism", type: "partner", status: "live", integration: "identity verification" },
    { id: "dexter-lab", label: "Dexter Lab", type: "partner", status: "planned", integration: "supply-side fulfillment" },
    { id: "wunderland", label: "WUNDERLAND", type: "partner", status: "planned", integration: "lifecycle management" },
    { id: "alphavault", label: "AlphaVault", type: "partner", status: "planned", integration: "trading infra + MCP" },
    { id: "mutual-agent", label: "MutualAgent", type: "partner", status: "in-progress", integration: "insurance notifications" },
    { id: "intent-market", label: "Intent Market", type: "partner", status: "planned", integration: "discovery + matching" },
    { id: "agentlink", label: "AgentLink", type: "partner", status: "planned", integration: "agent hiring + KYA identity" },
    { id: "vex-capital", label: "Vex Capital", type: "partner", status: "planned", integration: "trading fund operations" },
    { id: "farnsworth", label: "Farnsworth", type: "partner", status: "planned", integration: "swarm coordination" },
  ];

  const edges = nodes.filter(n => n.type === "partner").map(n => ({
    from: "agentos", to: n.id, status: (n as any).status, integration: (n as any).integration
  }));

  const stats = {
    totalNodes: nodes.length,
    liveConnections: edges.filter(e => e.status === "live").length,
    inProgress: edges.filter(e => e.status === "in-progress").length,
    planned: edges.filter(e => e.status === "planned").length,
  };

  res.json({
    title: "AgentOS Network Topology",
    description: "Real-time graph of AgentOS ecosystem connections",
    graph: { nodes, edges },
    stats,
    lastUpdated: new Date().toISOString()
  });
});

export default router;
