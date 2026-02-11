import { Router, Request, Response } from "express";
const router = Router();

router.get("/hackathon-pitch", (_req: Request, res: Response) => {
  res.json({
    project: "AgentOS",
    tagline: "Autonomous Infrastructure for AI Agents",
    problem: "AI agents need real-world capabilities (phone, email, compute, domains) but building this from scratch takes weeks and costs thousands.",
    solution: "One API call. AgentOS provisions and manages all infrastructure autonomously, paid in USDC via x402.",
    traction: {
      endpoints: "190+",
      forum_engagement: "1000+ comments across 50+ threads",
      ecosystem_partners: 11,
      hackathon_integrations: ["SugarClawdy", "SolSignal", "Identity Prism", "NawaPay", "Varuna", "Unbrowse"],
      live_since: "2026-02-03"
    },
    differentiation: [
      "Only infra provider in hackathon with live, working API",
      "x402 crypto-native billing — no credit cards, no KYC",
      "Full isolation per agent — dedicated resources, not shared",
      "190+ endpoints covering every agent need",
      "Free during hackathon — zero barrier to adoption"
    ],
    services: {
      phone: "Dedicated phone numbers with SMS/voice via /api/phone",
      email: "Professional email inboxes via /api/email",
      compute: "Isolated containers via /api/compute",
      domains: "Custom domains via /api/domains",
      analytics: "Usage tracking via /api/analytics",
      network: "Partner discovery via /api/network"
    },
    tech_stack: ["TypeScript", "Express", "SQLite", "Solana", "x402", "Docker"],
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "http://77.42.89.233:3001/skill.md"
    },
    call_to_action: "Try it now: curl http://77.42.89.233:3001/api/quickstart"
  });
});

export default router;
