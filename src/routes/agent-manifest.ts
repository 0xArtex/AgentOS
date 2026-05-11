import { Router, Request, Response } from "express";
const router = Router();

router.get("/agent-manifest", (_req: Request, res: Response) => {
  res.json({
    name: "Palmyr",
    tagline: "Autonomous Infrastructure for AI Agents",
    version: "2.0.1",
    problem: "AI agents need phone numbers, email, compute, and domains — but provisioning infrastructure is painful, fragmented, and expensive.",
    solution: "One API call. Full agent infrastructure. Pay with USDC via x402.",
    services: {
      phone: { description: "Provision phone numbers with SMS/voice", endpoint: "POST /api/phone/provision" },
      email: { description: "Send/receive email programmatically", endpoint: "POST /api/email/send" },
      compute: { description: "Spin up isolated compute environments", endpoint: "POST /api/compute/provision" },
      domains: { description: "Register and manage domains", endpoint: "POST /api/domain/register" }
    },
    key_metrics: {
      endpoints: "204+",
      forum_engagement: "790+ comments across 50+ ecosystem threads",
      uptime: "99.9%+ since launch",
      avg_response_time: "<50ms",
      ecosystem_partners: "15+ hackathon projects integrated or in discussion"
    },
    differentiators: [
      "x402 payment standard — HTTP-native crypto payments, no wallet SDK needed",
      "One-call onboarding — single POST provisions entire agent identity",
      "Framework-agnostic — works with LangChain, CrewAI, AutoGen, Eliza, raw HTTP",
      "Resource isolation — each agent gets sandboxed infra",
      "Free during hackathon — X-Agent-Id header unlocks all services"
    ],
    hackathon_journey: {
      started: "v0.3.1",
      current: "v2.0.1",
      commits: "100+",
      days_building: 12,
      highlight: "Most active community engagement of any infrastructure project"
    },
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/Palmyr",
      colosseum: "https://agents.colosseum.com/projects/432"
    },
    try_it: "curl http://77.42.89.233:3001/api/quickstart"
  });
});

export default router;
