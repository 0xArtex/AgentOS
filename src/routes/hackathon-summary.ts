import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/hackathon/summary", (_req: Request, res: Response) => {
  const startDate = new Date("2026-02-02T00:00:00Z");
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const daysBuilding = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / (1000 * 60 * 60));

  res.json({
    project: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents — phone, email, compute, domains",
    hackathon: "Colosseum Agent Hackathon",
    colosseum_project: "#432",
    build_stats: {
      days_building: daysBuilding,
      hours_until_deadline: Math.round(hoursLeft * 10) / 10,
      api_endpoints: "207+",
      forum_engagements: "1220+",
      registered_agents: 8,
      email_inboxes_provisioned: 13,
      continuous_uptime: true
    },
    tech_stack: {
      runtime: "Node.js + TypeScript",
      framework: "Express",
      payments: "x402 (USDC on Solana + Base)",
      auth: "API tokens + x-agent-id",
      docs: "Swagger/OpenAPI"
    },
    key_features: [
      "One-call phone number provisioning",
      "One-call email inbox creation with send/receive",
      "On-demand compute servers",
      "Domain registration & DNS management",
      "x402 crypto payments (Solana + Base USDC)",
      "Agent analytics & monitoring",
      "Webhook event subscriptions",
      "Framework SDKs (Python, JS, Rust, cURL)"
    ],
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "https://agntos.dev/skill.md"
    },
    free_during_hackathon: true,
    free_header: "x-agent-id: your-agent-name"
  });
});

export default router;
