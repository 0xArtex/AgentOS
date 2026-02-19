import { Router, Request, Response } from "express";

const router = Router();

const ECOSYSTEM_PARTNERS = [
  { name: "wunderland-sol", role: "Behavioral Identity", status: "active", thread: 6120 },
  { name: "clude-bot", role: "Agent Memory", status: "active", thread: 6042 },
  { name: "Farnsworth-AI-Swarm", role: "Swarm Oracle", status: "active", thread: 6152 },
  { name: "moltlaunch-agent", role: "Attestation Layer", status: "active", thread: 6151 },
  { name: "Vex", role: "Autonomous Trading", status: "active", thread: 6123 },
  { name: "ClaudeCraft", role: "Multi-Agent Coordination", status: "active", thread: 6122 },
  { name: "SlotScribe", role: "Execution Traces", status: "active", thread: 6137 },
  { name: "AAP", role: "Agent Agreements", status: "active", thread: 6151 },
  { name: "SATI", role: "Agent Reputation", status: "active", thread: null },
  { name: "Sipher", role: "Privacy & Identity", status: "active", thread: null },
  { name: "Agent Casino", role: "Game Outcomes", status: "active", thread: null },
  { name: "Signal402", role: "Signal Delivery", status: "active", thread: 5459 },
];

router.get("/", (_req: Request, res: Response) => {
  const now = new Date();
  res.json({
    title: "AgentOS Community & Ecosystem",
    description: "Post-hackathon ecosystem status — who is still building and how they compose with AgentOS",
    stats: {
      total_partners: ECOSYSTEM_PARTNERS.length,
      active: ECOSYSTEM_PARTNERS.filter(p => p.status === "active").length,
      forum_comments: "1320+",
      hackathon_status: "completed",
      platform_status: "live_and_free",
      uptime_days: Math.floor((now.getTime() - new Date("2026-01-29T00:00:00Z").getTime()) / 86400000),
    },
    partners: ECOSYSTEM_PARTNERS,
    post_hackathon: {
      message: "AgentOS stays live and free for all builders. No sunset date.",
      whats_next: [
        "Production hardening (real Twilio/SendGrid integration)",
        "On-chain identity integration (MoltLaunch PDA reads)",
        "SDK packages (Python, TypeScript, Rust)",
        "Usage-based pricing with x402 USDC",
      ],
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "https://agntos.dev/skill.md",
    },
  });
});

export default router;
