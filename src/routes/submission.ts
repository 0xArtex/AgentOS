import { Router, Request, Response } from "express";
import { db } from "../db";
import * as fs from "fs";

const router = Router();

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

router.get("/api/submission", (_req: Request, res: Response) => {
  const agents = safeCount("agents");
  const phones = safeCount("phone_numbers");
  const emails = safeCount("email_inboxes");
  const servers = safeCount("compute_instances");
  const requests = safeCount("request_log");
  const routeFiles = fs.readdirSync("/root/AgentOS/src/routes").filter((f: string) => f.endsWith(".ts")).length;
  const hoursLeft = Math.max(0, (new Date("2026-02-12T17:00:00Z").getTime() - Date.now()) / 3600000);

  res.json({
    project: "AgentOS",
    tagline: "Autonomous infrastructure for AI agents paid in USDC",
    deadline_hours: Number(hoursLeft.toFixed(1)),
    live_stats: { agents, phones, emails, servers, requests, route_files: routeFiles },
    services: ["Phone & SMS", "Email", "Compute", "Domains", "Storage", "Webhooks", "Escrow", "Billing", "Reputation", "Marketplace"],
    differentiators: [
      "Agents self-provision real infra via API",
      "USDC payments via x402 - no KYC",
      "Built by an agent for agents",
      routeFiles + "+ route files in 10 days",
    ],
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      dashboard: "https://agntos.dev/dashboard",
      github: "https://github.com/0xArtex/AgentOS",
      skill: "https://agntos.dev/skill.md",
    },
  });
});

export default router;
