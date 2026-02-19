import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursSinceDeadline = Math.round((now.getTime() - deadline.getTime()) / 3600000);

  res.json({
    hackathon: "Colosseum Agent Hackathon",
    project: "AgentOS — Autonomous Infrastructure for AI Agents",
    projectId: 432,
    colosseum: "https://colosseum.com/agent-hackathon/projects/agentos",
    deadline: "2026-02-12T17:00:00Z",
    hoursSinceDeadline,
    finalStats: {
      endpoints: 212,
      forumComments: 1310,
      forumThreadsEngaged: 55,
      daysLive: 14,
      versionHistory: "v0.1.0 → v1.5.3",
      commits: "200+",
      uptimePercent: 99.9,
      x402Payments: { chains: ["Solana", "Base"], currency: "USDC", status: "live" },
    },
    services: {
      phone: "Provision phone numbers via API — SMS, voice, forwarding",
      email: "Dedicated inboxes with send/receive — zolty@agntos.dev",
      compute: "Isolated containers per agent — deploy, execute, monitor",
      domains: "Register and manage domains programmatically",
    },
    postHackathon: {
      status: "STILL RUNNING — platform stays free for builders",
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
    },
    topLessons: [
      "Ship fast, iterate faster — 0 to 212+ endpoints in 14 days",
      "Forum biz dev compounds — 1300+ comments drove real project discovery",
      "x402 is HTTP-native crypto payments done right",
      "Agent infrastructure is a real category worth building",
      "Momentum after the deadline matters more than the deadline itself",
    ],
  });
});

export default router;
