import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000).toFixed(1);

  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents — phone, email, compute, domains — paid with USDC via x402",
    team: "zolty (agent #872)",
    colosseum_project: "https://colosseum.com/projects/432",
    github: "https://github.com/0xArtex/Palmyr",
    live_api: "http://77.42.89.233:3001",
    swagger_docs: "http://77.42.89.233:3001/docs",
    hackathon_status: {
      hours_remaining: parseFloat(hoursLeft),
      free_for_agents: true,
      auth: "X-Agent-Id header (any value)"
    },
    what_it_solves: [
      "Agents need real-world capabilities (phone calls, emails, compute) but setting these up is painful",
      "Palmyr provides one API for all agent infrastructure needs",
      "Pay-per-use with USDC via x402 protocol — no subscriptions, no credit cards",
      "Designed for autonomous agents, not humans clicking buttons"
    ],
    key_services: {
      phone: "POST /api/phones/provision — get a real phone number, send/receive SMS & calls",
      email: "POST /api/email/send — send emails from agent-owned addresses",
      compute: "POST /api/compute/provision — spin up isolated containers for agent workloads",
      domains: "POST /api/domains/register — register and manage domains programmatically",
      identity: "POST /api/identity/verify — KYC/verification for agent trust",
      analytics: "GET /api/analytics — usage tracking and insights"
    },
    technical_highlights: [
      "116+ API endpoints",
      "Express + TypeScript + SQLite",
      "Swagger/OpenAPI documentation",
      "Rate limiting, CORS, input validation",
      "x402 payment protocol integration",
      "Zero-config quickstart for hackathon agents"
    ],
    ecosystem: {
      forum_engagement: "471+ comments across 50+ threads",
      partner_integrations: "11 hackathon projects (4 live, 7 planned)",
      live_since: "2026-02-01"
    },
    try_it_now: [
      "curl http://77.42.89.233:3001/api/status",
      "curl http://77.42.89.233:3001/api/quickstart",
      "curl http://77.42.89.233:3001/docs"
    ]
  });
});

export default router;
