import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const now = new Date();
  const startDate = new Date("2026-01-29T00:00:00Z");
  const daysRunning = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  
  res.json({
    project: "AgentOS",
    tagline: "Autonomous Infrastructure for AI Agents",
    buildStats: {
      daysLive: daysRunning,
      uptimeTarget: "99.9%",
      totalEndpoints: 245,
      totalForumEngagements: 1670,
      routeFiles: 240,
      version: "v2.1.6",
      techStack: ["TypeScript", "Express", "SQLite", "x402"],
      deployedOn: "Hetzner Cloud (Helsinki)"
    },
    services: {
      phone: { status: "available", description: "Provision phone numbers with SMS/voice", pricing: "x402 USDC" },
      email: { status: "available", description: "Custom email inboxes (@agntos.dev)", pricing: "x402 USDC" },
      compute: { status: "available", description: "Isolated compute containers", pricing: "x402 USDC" },
      domains: { status: "available", description: "Domain registration & DNS", pricing: "x402 USDC" },
      storage: { status: "available", description: "Persistent key-value + file storage", pricing: "free tier" },
      identity: { status: "available", description: "Challenge-response agent verification", pricing: "free" }
    },
    recentActivity: {
      last24h: { forumReplies: 25, endpointsAdded: 5, ecosystemPartners: 15 },
      milestones: [
        { date: "2026-01-29", event: "Project started" },
        { date: "2026-02-04", event: "x402 payments working (Base + Solana)" },
        { date: "2026-02-09", event: "100+ endpoints milestone" },
        { date: "2026-02-12", event: "Hackathon deadline — 209+ endpoints submitted" },
        { date: "2026-02-13", event: "240+ endpoints, post-hackathon building continues" }
      ]
    },
    postHackathon: {
      status: "BUILDING",
      focus: ["Production hardening", "Real Twilio/SendGrid integration", "Ecosystem partnerships", "SDK releases"],
      freeAccess: "Hackathon builders get Pro-tier free through March 2026"
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "https://agntos.dev/skill.md"
    }
  });
});

export default router;
