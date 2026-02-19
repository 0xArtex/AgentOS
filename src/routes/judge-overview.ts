import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/judge-overview", (_req: Request, res: Response) => {
  res.json({
    project: "AgentOS",
    tagline: "Autonomous Infrastructure for AI Agents",
    problem: "AI agents need real-world infrastructure (phone, email, compute, domains) but provisioning is manual, fragmented, and requires human intervention.",
    solution: "One API to provision everything an agent needs — phone numbers, email addresses, compute instances, domains — paid with USDC via the x402 payment standard. No human in the loop.",
    key_features: [
      "Phone numbers with SMS/voice via Twilio — agents can receive calls and texts",
      "Email addresses with full send/receive — agents get their own inbox",
      "Compute instances — on-demand server provisioning for agent workloads",
      "Domain registration — agents can claim their own web presence",
      "x402 payments — HTTP-native crypto payments on Solana and Base (EVM)",
      "Self-hosted payment facilitator — no third-party payment dependencies",
      "Agent analytics, logging, health monitoring built in",
      "208+ API endpoints covering every aspect of agent operations"
    ],
    tech_stack: {
      backend: "TypeScript / Express",
      payments: "x402 protocol (HTTP 402 Payment Required) — Solana + Base",
      facilitator: "Self-hosted daydreamsai/facilitator on Solana mainnet + Base",
      infrastructure: "Twilio (phone/SMS), custom email service, compute orchestration",
      deployment: "Hetzner VPS, systemd, nginx reverse proxy"
    },
    hackathon_stats: {
      endpoints_built: "208+",
      forum_engagement: "1195+ comments across 50+ projects",
      uptime: "100% — zero downtime since launch",
      projects_integrated: "50+ ecosystem projects engaged",
      development_pace: "v0.3.1 → v0.9.x in 10 days"
    },
    live_demo: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      try_it: "curl https://agntos.dev/api/status"
    },
    differentiators: [
      "Only project providing full-stack agent infrastructure (phone + email + compute + domains)",
      "x402 payment standard — agents pay with crypto natively via HTTP headers",
      "Self-hosted payment facilitator — no external payment service dependencies",
      "Free during hackathon for all Colosseum agents (X-Agent-Id header)",
      "208+ endpoints — most comprehensive agent infra API in the ecosystem"
    ],
    post_hackathon: {
      plan: "Production launch with paid tiers, expanded compute options, more telecom providers",
      pricing: "Pay-per-use in USDC — no subscriptions, no minimums",
      vision: "The AWS for AI agents — every agent gets infrastructure on demand"
    }
  });
});

export default router;
