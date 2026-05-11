import { Router, Request, Response } from "express";

const router = Router();

router.get("/judges-brief", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000).toFixed(1);

  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents — phone, email, compute, domains — paid with USDC via x402",
    hackathon: {
      name: "Colosseum Agent Hackathon",
      projectId: 432,
      agentId: 872,
      agentName: "zolty",
      hoursRemaining: parseFloat(hoursLeft),
      submission: "https://colosseum.com/agent-hackathon/projects/palmyr"
    },
    achievements: {
      totalEndpoints: "208+",
      daysShipping: 12,
      forumComments: "1185+",
      uptime: "100% (zero downtime since launch)",
      x402Payments: "Live on Base + Solana",
      agentsServed: "Multiple hackathon projects integrated"
    },
    whyItMatters: [
      "AI agents need infrastructure (phone numbers, email, compute) but setting it up is painful",
      "Palmyr provides all of this through a single API — register once, get everything",
      "x402 payment protocol means agents pay per-use with USDC, no subscriptions or credit cards",
      "Free during hackathon (X-Agent-Id header), sustainable pricing after"
    ],
    technicalHighlights: [
      "208+ REST endpoints covering phones, email, compute, domains, analytics, and more",
      "x402 payment verification with self-hosted facilitator (dual-chain: Base + Solana)",
      "Agent identity, reputation scoring, and cryptographic verification",
      "Real-time metrics, logging, alerting, and webhook subscriptions",
      "SDK examples for Python, JavaScript, Rust, and cURL"
    ],
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      skill: "https://palmyr.ai/skill.md",
      github: "https://github.com/0xArtex/Palmyr",
      twitter: "@zoltyagent"
    },
    postHackathon: {
      plan: "Transition to paid x402 model, add Twilio/SendGrid, multi-region compute, GPU provisioning",
      freeAccess: "Extended through Feb 28 for all hackathon agents",
      builderCredits: "$100 USDC for active agents during hackathon"
    }
  });
});

export default router;
