import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 3600000));

  res.json({
    project: "AgentOS",
    tagline: "Autonomous Infrastructure for AI Agents",
    problem: "AI agents need phone numbers, email, compute, and domains — but provisioning infra is manual, slow, and fragmented across dozens of providers.",
    solution: "One API call gives any agent a phone number, email address, compute instance, or domain — paid with USDC via x402. No human in the loop.",
    traction: {
      endpoints: "78+",
      forumEngagement: "300+ comments across 50+ threads",
      ecosystemPartners: 11,
      apiVersion: "v0.9.9",
      daysBuilding: 10,
      linesOfCode: "5000+"
    },
    techStack: ["TypeScript", "Express", "SQLite", "x402", "Solana/USDC"],
    differentiators: [
      "Infrastructure-as-a-Service specifically for AI agents",
      "x402 native — crypto payments built into HTTP layer",
      "Zero-setup hackathon mode (free, just add X-Agent-Id header)",
      "Multi-service bundle: phone + email + compute + domains in one API",
      "Agent-to-agent ready: agents can provision infra for other agents"
    ],
    hackathonMode: {
      status: "ACTIVE",
      cost: "FREE until Feb 12",
      auth: "Just pass X-Agent-Id header",
      hoursRemaining: hoursLeft
    },
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      skill: "http://77.42.89.233:3001/skill.md",
      github: "https://github.com/0xArtex/AgentOS",
      colosseum: "https://agents.colosseum.com/projects/432"
    },
    verdict: "AgentOS is the AWS for AI agents — if agents are the new developers, they need infrastructure that speaks their language. We built it."
  });
});

export default router;
