import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

function safeCount(table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
    return row?.count || 0;
  } catch { return 0; }
}

router.get("/hackathon-stats", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 3600000 * 10) / 10);

  res.json({
    hackathon: "Colosseum Agent Hackathon",
    project: "Palmyr — Autonomous Infrastructure for AI Agents",
    projectId: 432,
    deadline: "2026-02-12T17:00:00Z",
    hoursRemaining: hoursLeft,
    liveStats: {
      registeredAgents: safeCount("agents"),
      provisionedPhones: safeCount("phones"),
      provisionedEmails: safeCount("emails"),
      activeServers: safeCount("servers"),
      totalEndpoints: 103,
      forumComments: "425+",
      version: "v1.1.6",
      ecosystemPartners: 11
    },
    highlights: [
      "Full agent lifecycle management",
      "x402 USDC payments (free during hackathon)",
      "Real-time telemetry and activity feeds",
      "One-call bootstrap for instant setup",
      "Live system health metrics"
    ],
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/Palmyr"
    }
  });
});

export default router;
