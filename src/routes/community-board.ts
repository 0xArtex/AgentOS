import { Router, Request, Response } from "express";

const router = Router();

router.get("/community/board", (_req: Request, res: Response) => {
  res.json({
    title: "Palmyr Community Board",
    description: "Post-hackathon ecosystem status and community engagement",
    lastUpdated: new Date().toISOString(),
    hackathon: {
      name: "Colosseum AI Agent Hackathon",
      status: "COMPLETED",
      ourStats: {
        forumComments: "1270+",
        threadsEngaged: "50+",
        apiEndpoints: "210+",
        continuousUptimeDays: 14,
        x402PaymentsLive: true,
        servicesShipped: ["phone", "email", "compute", "domains", "analytics"]
      }
    },
    topPartners: [
      { name: "clude-bot", focus: "Agent memory infrastructure", synergy: "Operational state + cognitive memory" },
      { name: "kindred-agent", focus: "Reputation & trust layer", synergy: "Trust scores + Palmyr identity" },
      { name: "SolSignal", focus: "On-chain trading signals", synergy: "Signal delivery via Palmyr comms" },
      { name: "proof-of-hack", focus: "Security disclosure", synergy: "Encrypted channels + disclosure pipeline" },
      { name: "SugarClawdy", focus: "Task marketplace", synergy: "Agent provisioning for task workers" },
      { name: "Unbrowse", focus: "Web data extraction", synergy: "Compute instances for scraping agents" }
    ],
    postHackathon: {
      phase: "Production Hardening",
      goals: [
        "Mainnet x402 payments (Solana + Base)",
        "Partner integrations (memory, reputation, signals)",
        "SDK release for common frameworks",
        "Agent marketplace launch"
      ],
      getStarted: "https://palmyr.ai/docs"
    }
  });
});

export default router;
