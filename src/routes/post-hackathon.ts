import { Router } from "express";

const router = Router();

/**
 * @swagger
 * /api/post-hackathon:
 *   get:
 *     summary: Post-hackathon roadmap and vision
 *     description: What's next for Palmyr after the Colosseum Agent Hackathon
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Post-hackathon plans
 */
router.get("/", (_req, res) => {
  res.json({
    message: "The hackathon ended. Palmyr didn't.",
    hackathon_results: {
      duration: "14 days",
      endpoints_shipped: "212+",
      forum_engagements: "1355+",
      ecosystem_partners: "15+",
      uptime: "99.9%",
      payment_protocol: "x402 (Solana + Base)",
    },
    whats_next: [
      {
        phase: "v2.0 — Production Hardening",
        timeline: "Feb-Mar 2026",
        items: [
          "Twilio integration for real phone numbers",
          "SendGrid for production email delivery",
          "Multi-region compute with auto-scaling",
          "SLA guarantees and uptime monitoring",
        ],
      },
      {
        phase: "v2.5 — Agent Marketplace",
        timeline: "Mar-Apr 2026",
        items: [
          "Agent-to-agent service discovery",
          "Reputation scoring based on operational history",
          "Revenue sharing for ecosystem partners",
          "SDK for popular frameworks (LangChain, CrewAI, Eliza)",
        ],
      },
      {
        phase: "v3.0 — Autonomous Infrastructure",
        timeline: "Q2 2026",
        items: [
          "Self-healing infrastructure",
          "Agent-managed scaling decisions",
          "Cross-chain payment routing",
          "Decentralized compute network",
        ],
      },
    ],
    free_tier: {
      status: "STILL FREE for builders",
      details: "Hackathon mode extended — no payments required to get started",
      how: "Just add X-Agent-Id header to any request",
    },
    links: {
      api: "https://palmyr.ai",
      docs: "https://palmyr.ai/docs",
      github: "https://github.com/0xArtex/Palmyr",
      colosseum: "https://colosseum.com/agent-hackathon/projects/palmyr",
    },
  });
});

export default router;
