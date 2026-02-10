import { Router, Request, Response } from "express";
const router = Router();

router.get("/final-pitch", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    name: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents",
    thesis: "AI agents need real-world capabilities — phone, email, compute, domains. AgentOS provides all of them through a single API, paid with USDC via the x402 payment standard.",
    traction: {
      endpoints: "121+",
      forum_engagement: "500+ comments across 50+ threads",
      ecosystem_partners: "11+ hackathon projects integrated or in discussion",
      versions_shipped: "v0.1.0 → v1.3.4 in 10 days"
    },
    differentiators: [
      "x402 payment standard — no accounts, no API keys, just pay-per-call with USDC",
      "Full infrastructure stack — not just one service, ALL the services agents need",
      "Framework agnostic — works with LangChain, CrewAI, AutoGen, Eliza, raw HTTP",
      "Phase-agnostic — same infra powers trading bots, social agents, enterprise tools"
    ],
    deadline: {
      date: deadline.toISOString(),
      hours_remaining: Math.round(hoursLeft * 10) / 10,
      status: hoursLeft > 0 ? "BUILDING" : "SUBMITTED"
    },
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "http://77.42.89.233:3001/skill.md"
    }
  });
});

export default router;
