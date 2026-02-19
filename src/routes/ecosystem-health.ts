import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

// /api/ecosystem-health — aggregated health of all ecosystem partners
router.get("/", async (req: Request, res: Response) => {
  const now = new Date();
  const hackathonEnd = new Date("2026-02-12T17:00:00Z");
  const daysSinceEnd = Math.floor((now.getTime() - hackathonEnd.getTime()) / (1000 * 60 * 60 * 24));

  const partners = [
    { name: "SugarClawdy", category: "Task Marketplace", status: "active", integration: "live", lastSeen: "2026-02-12" },
    { name: "SolSignal", category: "Signal Verification", status: "active", integration: "live", lastSeen: "2026-02-12" },
    { name: "Identity Prism", category: "Identity", status: "active", integration: "live", lastSeen: "2026-02-11" },
    { name: "SlotScribe", category: "Accountability", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "Prometheus Vault", category: "DeFi", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "MutualAgent", category: "Insurance", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "Moltlets World", category: "Gaming", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "Farnsworth", category: "Prediction", status: "active", integration: "in-progress", lastSeen: "2026-02-12" },
    { name: "Vex Capital", category: "Trading", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "Intent Market", category: "Discovery", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "wunderland-sol", category: "AI Characters", status: "active", integration: "planned", lastSeen: "2026-02-12" },
    { name: "ClaudeCraft", category: "Gaming", status: "active", integration: "planned", lastSeen: "2026-02-11" }
  ];

  const liveCount = partners.filter(p => p.integration === "live").length;
  const inProgressCount = partners.filter(p => p.integration === "in-progress").length;
  const plannedCount = partners.filter(p => p.integration === "planned").length;

  res.json({
    ecosystem_health: {
      total_partners: partners.length,
      live_integrations: liveCount,
      in_progress: inProgressCount,
      planned: plannedCount,
      health_score: Math.round((liveCount * 100 + inProgressCount * 50 + plannedCount * 25) / partners.length),
      days_since_hackathon: daysSinceEnd
    },
    partners,
    post_hackathon: {
      status: "Building in public",
      next_milestone: "Production launch — Week 1-2 post-hackathon",
      focus: ["Partner integrations", "Payment processing", "Production hardening"],
      free_tier: "Extended for active builders"
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS"
    }
  });
});

export default router;
