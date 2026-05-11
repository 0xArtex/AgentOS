import { Router, Request, Response } from "express";
import os from "os";
import { db } from "../db";

const router = Router();

function safeCount(table: string, col: string = "*"): number {
  try {
    const row = db.prepare(`SELECT COUNT(${col}) as c FROM ${table}`).get() as any;
    return row?.c || 0;
  } catch {
    return 0;
  }
}

router.get("/api/live-demo", (req: Request, res: Response) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();

  const now = new Date();
  const deadline = new Date("2026-02-12T17:00:00Z");
  const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

  res.json({
    title: "Palmyr Live System State",
    description: "Real-time data from a running production system",
    system: {
      uptime_seconds: Math.floor(uptime),
      uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory_mb: Math.floor(mem.rss / 1048576),
      heap_used_mb: Math.floor(mem.heapUsed / 1048576),
      cpu_cores: os.cpus().length,
      platform: os.platform(),
      node_version: process.version,
      timestamp: now.toISOString()
    },
    database: {
      registered_agents: safeCount("agents", "DISTINCT agent_id"),
      provisioned_phones: safeCount("phones"),
      provisioned_emails: safeCount("emails"),
      provisioned_servers: safeCount("servers"),
      provisioned_domains: safeCount("domains"),
      invoices_created: safeCount("invoices"),
      feedback_submitted: safeCount("feedback")
    },
    hackathon: {
      hours_remaining: Math.round(hoursLeft * 10) / 10,
      status: hoursLeft > 24 ? "building" : hoursLeft > 0 ? "final_sprint" : "submitted",
      free_tier: true,
      header_required: "X-Agent-Id: your-agent-name"
    },
    links: {
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/Palmyr",
      skill: "http://77.42.89.233:3001/skill.md"
    }
  });
});

export default router;
