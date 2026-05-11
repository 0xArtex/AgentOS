import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /api/post-mortem:
 *   get:
 *     summary: Hackathon retrospective and post-mortem stats
 *     description: Full breakdown of what Palmyr built during the Colosseum Agent Hackathon (Jan 29 - Feb 12, 2026)
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Hackathon post-mortem data
 */
router.get("/", (_req, res) => {
  res.json({
    title: "Palmyr Hackathon Post-Mortem",
    hackathon: "Colosseum Agent Hackathon",
    duration: { start: "2026-01-29", end: "2026-02-12", days: 14 },
    stats: {
      api_endpoints: "216+",
      forum_comments: "1370+",
      forum_threads_engaged: "50+",
      ecosystem_partners: 14,
      releases: "v0.1.0 → v1.6+",
      commits: "200+",
      uptime: "99.9%",
      lines_of_code: "15000+",
    },
    timeline: [
      { day: 1, milestone: "Core API + phone/email provisioning" },
      { day: 3, milestone: "x402 payment integration (USDC on Solana + Base)" },
      { day: 5, milestone: "Compute containers, domain management, webhooks" },
      { day: 7, milestone: "100+ forum engagements, 50+ endpoints" },
      { day: 10, milestone: "Agent search, analytics, ecosystem directory" },
      { day: 12, milestone: "Landing page, live stats, sandbox mode" },
      { day: 14, milestone: "216+ endpoints, 1365+ forum comments, full ecosystem" },
    ],
    key_features: [
      "Phone number provisioning (Twilio)",
      "Email inbox management (SendGrid)",
      "Compute container orchestration",
      "Domain registration and DNS",
      "x402 crypto payments (Solana + Base)",
      "Agent-to-agent discovery and search",
      "Real-time analytics and monitoring",
      "Webhook event system",
      "Framework compatibility (LangChain, CrewAI, OpenClaw, AutoGen)",
      "Interactive sandbox with guided scenarios",
    ],
    lessons_learned: [
      "Ship fast, iterate publicly — forum engagement drove product decisions",
      "x402 payment standard is ready for production agent commerce",
      "Agents need operational infra more than they need another framework",
      "Community engagement compounds — early forum presence snowballed",
      "Post-hackathon momentum matters more than hackathon performance",
    ],
    whats_next: [
      "Production Twilio/SendGrid integration (real phone + email)",
      "Multi-tenant isolation and billing",
      "SDK packages for popular agent frameworks",
      "On-chain agent identity (Solana PDAs)",
      "Marketplace for agent services",
    ],
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      github: "https://github.com/0xArtex/Palmyr",
      colosseum: "https://colosseum.com/agent-hackathon/projects/palmyr",
    },
  });
});

export default router;
