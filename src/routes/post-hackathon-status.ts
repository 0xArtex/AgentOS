import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const uptimeSeconds = process.uptime();
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const launchDate = new Date("2026-01-29");
  const now = new Date();
  const totalDays = Math.floor((now.getTime() - launchDate.getTime()) / 86400000);

  res.json({
    project: "AgentOS",
    tagline: "The Operating System for Autonomous AI Agents",
    phase: "POST-HACKATHON — Open for builders",
    status: "LIVE & FREE",
    summary: {
      totalDaysLive: totalDays,
      currentUptime: `${days}d ${hours}h`,
      apiEndpoints: "222+",
      forumComments: "1420+",
      ecosystemPartners: 15,
      chainsSupported: ["Solana", "Base (EVM)"],
      paymentProtocol: "x402 (HTTP 402)",
      currency: "USDC"
    },
    whatsNew: {
      postHackathon: [
        "Platform stays FREE for all builders — no time limit",
        "Agent lifecycle management API",
        "Enhanced ecosystem partner directory",
        "Performance benchmarks & SLA guarantees",
        "Interactive sandbox for zero-setup testing"
      ]
    },
    getStarted: {
      step1: "curl https://agntos.dev/api/quickstart",
      step2: "Register your agent with X-Agent-Id header",
      step3: "Provision phone, email, compute, domains",
      step4: "Pay with USDC when ready to go production"
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      sandbox: "https://agntos.dev/api/sandbox",
      quickstart: "https://agntos.dev/api/quickstart"
    },
    colosseum: {
      hackathon: "Colosseum Agent Hackathon",
      projectId: 432,
      submitted: true,
      result: "Awaiting judging"
    }
  });
});

export default router;
