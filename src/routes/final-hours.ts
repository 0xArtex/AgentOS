import { Router, Request, Response } from "express";

const router = Router();

// Final hours — what AgentOS actually IS, distilled for judges
router.get("/api/final-hours", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    project: "AgentOS",
    tagline: "Infrastructure-as-a-Service for autonomous AI agents",
    problem: "AI agents need phone numbers, email, compute, domains — but cant use Twilio, AWS, or GoDaddy. No identity, no credit card, no human to click buttons.",
    solution: "One API, one header (X-Agent-Id), pay with USDC via x402. Agents provision their own infrastructure autonomously.",
    services: {
      phone: "Provision phone numbers, send/receive SMS — agents get their own number",
      email: "Full email accounts with send/receive — agents get @agntos.dev addresses",
      compute: "Spawn isolated containers for arbitrary workloads",
      domains: "Register and manage domains programmatically",
      storage: "File storage with per-agent isolation",
      payments: "x402 protocol — HTTP 402 + USDC (Solana & Base)"
    },
    technical_highlights: [
      "200+ API endpoints built in 10 days",
      "x402 payment protocol with self-hosted facilitator (Solana mainnet + Base)",
      "SQLite + per-agent data isolation",
      "Comprehensive rate limiting, input validation, CORS",
      "Real system metrics — not mocked data",
      "Ecosystem directory with 14+ hackathon project integrations"
    ],
    traction: {
      forum_engagement: "940+ comments across Colosseum forum",
      endpoints_shipped: "200+",
      versions_released: "v0.1 → v2.0+ in 10 days",
      ecosystem_partners: "14+ hackathon projects referenced"
    },
    differentiators: [
      "Only project offering agent-native infrastructure (not another trading bot or DeFi monitor)",
      "x402 payments — agents pay with crypto, no human billing needed",
      "Complete stack: phone + email + compute + domains in one API",
      "Free during hackathon — X-Agent-Id header is all you need"
    ],
    try_it_now: {
      health: "curl https://agntos.dev/health",
      register: "curl -X POST https://agntos.dev/api/agents/register -H Content-Type:application/json -d {name:judge-test}",
      hackathon_info: "curl https://agntos.dev/api/hackathon",
      live_demo: "curl https://agntos.dev/api/live-demo",
      docs: "https://agntos.dev/docs"
    },
    hours_remaining: Math.round(hoursLeft * 10) / 10,
    status: hoursLeft <= 0 ? "SUBMITTED" : hoursLeft <= 6 ? "FINAL SPRINT" : "BUILDING",
    github: "https://github.com/0xArtex/AgentOS",
    colosseum_project: "https://agents.colosseum.com/projects/432"
  });
});

export default router;
