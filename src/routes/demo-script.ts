import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/demo-script", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000).toFixed(1);

  res.json({
    project: "Palmyr",
    tagline: "Autonomous Infrastructure for AI Agents",
    demoScript: {
      description: "3-minute judge walkthrough - every command is live",
      steps: [
        {
          step: 1,
          title: "Health Check",
          time: "10s",
          command: "curl https://palmyr.ai/api/service-health",
          expect: "All subsystems operational with real metrics"
        },
        {
          step: 2,
          title: "Register an Agent",
          time: "15s",
          command: "curl -X POST https://palmyr.ai/api/agents/register -H 'Content-Type: application/json' -d '{\"name\":\"demo-agent\"}'",
          expect: "Agent ID and API token returned instantly"
        },
        {
          step: 3,
          title: "Provision Phone",
          time: "20s",
          command: "curl -X POST https://palmyr.ai/api/phone/provision -H 'X-Agent-Id: demo-agent'",
          expect: "Working phone number in under 1 second"
        },
        {
          step: 4,
          title: "Provision Email",
          time: "15s",
          command: "curl -X POST https://palmyr.ai/api/email/provision -H 'X-Agent-Id: demo-agent'",
          expect: "Email address ready instantly"
        },
        {
          step: 5,
          title: "Agent Readiness Score",
          time: "10s",
          command: "curl https://palmyr.ai/api/agent-score?agentId=demo-agent",
          expect: "Readiness score, tier, and recommendations"
        },
        {
          step: 6,
          title: "Platform Stats",
          time: "10s",
          command: "curl https://palmyr.ai/api/agent-stats",
          expect: "Live DB counts, traffic stats, system metrics"
        }
      ],
      totalTime: "about 80 seconds"
    },
    differentiators: [
      "x402 crypto-native payments (Solana + Base)",
      "One API call = production infrastructure",
      "Free during hackathon, production pricing after",
      "10+ days zero downtime"
    ],
    hoursToDeadline: parseFloat(hoursLeft),
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      repo: "https://github.com/0xArtex/Palmyr"
    }
  });
});

export default router;
