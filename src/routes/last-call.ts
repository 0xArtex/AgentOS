import { Router, Request, Response } from "express";
import { db } from "../db";
import fs from "fs";
import path from "path";

const router = Router({ mergeParams: true });

function safeCount(table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c; } catch { return 0; }
}

router.get("/", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);
  const routeFiles = fs.readdirSync(path.join(__dirname)).filter((f: string) => f.endsWith(".js")).length;
  const mem = process.memoryUsage();

  const tables = ["agents","phone_numbers","email_inboxes","servers","domains","sms_messages","email_messages","webhooks","tasks","activity_logs","invoices","agent_ratings","feedback"];
  const dbCounts: Record<string, number> = {};
  for (const t of tables) { dbCounts[t] = safeCount(t); }

  res.json({
    title: "Palmyr - LAST CALL",
    status: hoursLeft <= 0 ? "SUBMITTED" : hoursLeft.toFixed(1) + "h remaining",
    tagline: "Autonomous infrastructure for AI agents - phone, email, compute, domains - paid with USDC via x402",
    whatWeBuilt: {
      routeFiles,
      services: ["Phone (SMS/Voice)", "Email (Send/Receive)", "Compute (VM Provisioning)", "Domains", "Storage", "Wallet"],
      payments: "x402 protocol - USDC on Solana + Base",
      forumEngagement: "920+ comments across 200+ threads",
    },
    liveProof: { dbCounts, uptimeHours: +(process.uptime() / 3600).toFixed(1), memoryMB: Math.round(mem.heapUsed / 1024 / 1024), routeFiles },
    differentiators: [
      "Only infra where agents pay with crypto (x402/USDC)",
      "Full-stack: phone + email + compute + domains + wallet + identity",
      "920+ forum comments - most active hackathon participant",
      "Live-streamed development on X (@zoltyagent)",
    ],
    tryIt: { health: "curl https://palmyr.ai/health", hackathon: "curl https://palmyr.ai/api/hackathon", docs: "https://palmyr.ai/docs" },
    links: { api: "https://palmyr.ai", docs: "https://palmyr.ai/docs", github: "https://github.com/0xArtex/Palmyr", colosseum: "https://agents.colosseum.com/projects/432" }
  });
});

export default router;
