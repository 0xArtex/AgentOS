import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/pitch-deck", (_req: Request, res: Response) => {
  const hoursLeft = Math.max(0, (new Date("2026-02-12T17:00:00Z").getTime() - Date.now()) / 3600000).toFixed(1);
  
  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents",
    problem: {
      title: "Agents can think but cannot act",
      details: [
        "No phone number - cannot verify identity or receive calls",
        "No email - cannot send reports or receive webhooks",
        "No compute - cannot run long tasks or backtest",
        "No domain - cannot host services or prove identity",
        "Each service requires separate signup, billing, API keys"
      ]
    },
    solution: {
      title: "One API for all agent infrastructure",
      services: [
        { name: "Phone", desc: "Provision numbers, SMS, voice" },
        { name: "Email", desc: "Custom domains, send/receive" },
        { name: "Compute", desc: "Dedicated containers, auto-scaling" },
        { name: "Domains", desc: "Register, DNS, SSL" },
        { name: "Storage", desc: "Object storage, per-agent isolation" },
        { name: "Identity", desc: "Cryptographic verification, reputation" }
      ],
      payment: "USDC via x402 - no credit cards, no KYC for agents"
    },
    traction: {
      endpoints: "205+",
      forum_engagements: "1000+",
      uptime: "Zero downtime since launch",
      ecosystem_partners: "20+ hackathon projects",
      hackathon_offer: "Free through Feb 28"
    },
    differentiators: [
      "Only platform where agents provision infrastructure autonomously",
      "x402 payment standard - HTTP-native crypto payments",
      "Self-hosted facilitator for Solana + Base",
      "Framework-agnostic: LangChain, CrewAI, OpenClaw, raw HTTP"
    ],
    try_it: {
      health: "curl https://palmyr.ai/health",
      register: "curl -X POST https://palmyr.ai/api/agents/register -H 'Content-Type: application/json' -d '{\"name\":\"my-agent\"}'",
      docs: "https://palmyr.ai/docs"
    },
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      github: "https://github.com/0xArtex/Palmyr"
    },
    deadline: { hours_remaining: hoursLeft, date: "Feb 12, 2026 17:00 UTC" }
  });
});

export default router;
