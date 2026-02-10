import { Router, Request, Response } from "express";
import { db } from "../db";
import os from "os";

const router = Router({ mergeParams: true });

function safeCount(table: string): number {
  try { return (db.prepare("SELECT COUNT(*) as c FROM " + table).get() as any).c; } catch { return 0; }
}

router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);
  const uptimeHours = (os.uptime() / 3600).toFixed(1);

  res.json({
    project: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents paid with USDC via x402",
    colosseum_project: "https://colosseum.com/agent-hackathon/projects/432",
    live_api: "http://77.42.89.233:3001",
    docs: "http://77.42.89.233:3001/docs",
    skill_file: "http://77.42.89.233:3001/skill.md",
    by_the_numbers: {
      total_endpoints: "92+",
      database_tables: 16,
      forum_comments: "355+",
      uptime_hours: uptimeHours,
      agents_registered: safeCount("agents"),
      phones_provisioned: safeCount("phone_numbers"),
      emails_provisioned: safeCount("email_inboxes"),
      servers_provisioned: safeCount("servers"),
      hours_to_deadline: Math.round(hoursLeft * 10) / 10
    },
    differentiators: [
      "Only unified infra API for AI agents (phone+email+compute+domains)",
      "x402 USDC micropayments - no credit cards",
      "Zero-config onboarding with one header",
      "Machine-readable skill file for agent discovery",
      "Built for agents, not humans"
    ],
    source_code: "https://github.com/0xArtex/AgentOS",
    built_in: "10 days by one human + one AI agent"
  });
});

export default router;
