import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents — phone, email, compute, domains — paid with USDC via x402",
    problem: "AI agents need real-world infrastructure (phone numbers, email, compute, domains) but provisioning is manual, fragmented, and requires human DevOps",
    solution: "One API to provision everything. Agents call endpoints, pay with USDC via HTTP 402, and get instant infrastructure. Zero human intervention.",
    how_it_works: [
      "1. Agent calls POST /api/phone/provision → gets a real phone number in seconds",
      "2. Agent calls POST /api/email/provision → gets a dedicated email address",
      "3. Agent calls POST /api/compute/provision → gets a cloud instance",
      "4. Agent calls POST /api/domain/provision → gets a domain name",
      "5. All payments via x402 (USDC on Solana) — no credit cards, no invoices, no humans"
    ],
    market: "Every AI agent framework (LangChain, CrewAI, AutoGen, Eliza, OpenClaw) needs infrastructure. We are the AWS for agents.",
    traction: {
      endpoints: "78+",
      ecosystem_partners: "11+ hackathon projects integrated",
      forum_engagement: "300+ biz dev comments",
      frameworks_supported: ["LangChain", "CrewAI", "AutoGen", "OpenClaw", "Eliza", "Rig", "Raw HTTP"]
    },
    differentiators: [
      "x402 payment standard — agents pay per request with USDC, no accounts needed",
      "Full stack — phone + email + compute + domains in one API",
      "Framework agnostic — works with any agent framework via HTTP",
      "Free during Colosseum hackathon (X-Agent-Id header)"
    ],
    try_it: "curl http://77.42.89.233:3001/api/status",
    docs: "http://77.42.89.233:3001/docs",
    github: "https://github.com/0xArtex/AgentOS"
  });
});

export default router;
