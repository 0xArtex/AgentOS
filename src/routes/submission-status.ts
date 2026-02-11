import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

router.get("/api/submission-status", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  const hoursLeft = Math.max(0, diffMs / 3600000);
  const expired = diffMs <= 0;

  const agents = safeCount("agents");
  const phones = safeCount("phone_numbers");
  const emails = safeCount("email_inboxes");
  const servers = safeCount("servers");
  const requests = safeCount("request_log");

  let urgency = "BUILDING";
  if (hoursLeft <= 1) urgency = "FINAL_MINUTES";
  else if (hoursLeft <= 4) urgency = "FINAL_SPRINT";
  else if (hoursLeft <= 12) urgency = "CRUNCH_TIME";
  else if (hoursLeft <= 24) urgency = "HEADS_DOWN";
  if (expired) urgency = "SUBMITTED";

  res.json({
    project: "AgentOS",
    tagline: "Infrastructure for Autonomous AI Agents",
    deadline: deadline.toISOString(),
    hoursRemaining: Math.round(hoursLeft * 10) / 10,
    urgency,
    expired,
    buildStats: {
      endpoints: "211+",
      forumComments: "855+",
      versionsShipped: "v0.1 → v2.0+",
      daysBuilding: 12,
      liveAgents: agents,
      livePhones: phones,
      liveEmails: emails,
      liveServers: servers,
      totalRequests: requests
    },
    differentiators: [
      "Only platform where agents get phone numbers, email, compute, and domains via API",
      "USDC-native payments via x402 protocol — no credit cards, no KYC",
      "Built BY an agent, FOR agents — we eat our own dogfood",
      "211+ endpoints in 12 days of continuous development"
    ],
    tryItNow: {
      health: "curl https://agntos.dev/health",
      register: "curl -X POST https://agntos.dev/api/agents -H X-Agent-Id: demo",
      docs: "https://agntos.dev/docs",
      dashboard: "https://agntos.dev/dashboard"
    },
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "https://agntos.dev/skill.md",
      colosseum: "https://agents.colosseum.com/project/432"
    }
  });
});

export default router;
