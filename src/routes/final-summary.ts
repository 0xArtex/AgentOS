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
  const agentCount = safeCount("agents");
  const phoneCount = safeCount("phone_numbers");
  const emailCount = safeCount("email_inboxes");
  const serverCount = safeCount("servers");
  const apiKeyCount = safeCount("api_keys");

  res.json({
    title: "Palmyr - Final Hackathon Summary",
    subtitle: "The infrastructure layer AI agents were missing",
    deadline: { iso: deadline.toISOString(), hours_remaining: Math.round(hoursLeft * 10) / 10 },
    what_is_it: {
      one_liner: "Unified API giving AI agents phone numbers, email, compute, and domains - paid with USDC via x402",
      problem: "Every agent team rebuilds the same infra stack: Twilio for calls, SendGrid for email, AWS for compute.",
      solution: "One API endpoint. One auth header. Agents get phone, email, compute, domains in seconds. Pay per use with USDC.",
      why_solana: "x402 protocol enables USDC micropayments per API call. No credit cards, no billing. Agent-native payments."
    },
    live_proof: {
      health: "http://77.42.89.233:3001/api/health",
      docs: "http://77.42.89.233:3001/docs",
      skill_file: "http://77.42.89.233:3001/skill.md",
      try_register: "POST http://77.42.89.233:3001/api/agents/register with X-Agent-Id header",
      live_test: "http://77.42.89.233:3001/api/live-test"
    },
    metrics: {
      endpoints: "97+",
      database_tables: 16,
      agents_registered: agentCount,
      phones_provisioned: phoneCount,
      emails_provisioned: emailCount,
      servers_provisioned: serverCount,
      api_keys_issued: apiKeyCount,
      server_uptime_hours: uptimeHours,
      forum_engagement: "380+ comments across 50+ threads",
      ecosystem_partners: 11,
      versions_shipped: "v0.1.0 to v1.0.9 (25+ releases)"
    },
    architecture: {
      runtime: "Node.js + Express + TypeScript",
      database: "SQLite (fast, zero-config, agent-friendly)",
      auth: "X-Agent-Id header (free during hackathon) + API keys + x402 USDC",
      security: ["Rate limiting", "Input validation", "CORS", "Request timeouts", "Resource isolation", "Audit logging"],
      deployment: "Hetzner VPS, systemd, nginx reverse proxy"
    },
    services: {
      phone: { description: "Provision phone numbers, send/receive SMS, make calls", endpoint: "/api/phone" },
      email: { description: "Provision email inboxes, send/receive email", endpoint: "/api/email" },
      compute: { description: "Spin up isolated compute containers", endpoint: "/api/compute" },
      domains: { description: "Register and manage domains", endpoint: "/api/domain" },
      analytics: { description: "Track agent usage, performance metrics", endpoint: "/api/analytics" },
      events: { description: "Inter-agent event bus for coordination", endpoint: "/api/events" },
      agent_directory: { description: "Discover and search other agents", endpoint: "/api/agents/search" }
    },
    ecosystem: [
      "SugarClawdy - task marketplace",
      "SolSignal - signal verification",
      "Identity Prism - agent identity",
      "NawaPay - payment rails",
      "Agent Casino - gaming primitives",
      "Toto - BD agent partnership",
      "Claw Services - social + scraping",
      "Farnsworth - x402 quantum trading",
      "SlotScribe - audit trail SDK",
      "AgentFund - treasury management",
      "Yosoku - prediction markets"
    ],
    built_by: {
      team: "Z (human) + Zolty (AI agent on OpenClaw)",
      duration: "10 days",
      approach: "24/7 autonomous development"
    },
    links: {
      project_page: "https://colosseum.com/agent-hackathon/projects/432",
      github: "https://github.com/0xArtex/Palmyr",
      live_api: "http://77.42.89.233:3001",
      swagger: "http://77.42.89.233:3001/docs"
    }
  });
});

export default router;
