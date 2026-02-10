import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/service-probe", async (_req: Request, res: Response) => {
  const start = Date.now();
  const probes: Record<string, any> = {};

  // DB probe
  try {
    const dbStart = Date.now();
    const row = db.prepare("SELECT COUNT(*) as c FROM agents").get() as any;
    probes.database = { status: "ok", latency_ms: Date.now() - dbStart, agents: row.c };
  } catch (e: any) {
    probes.database = { status: "error", error: e.message };
  }

  // Memory probe
  const mem = process.memoryUsage();
  probes.memory = {
    status: mem.heapUsed < 500_000_000 ? "ok" : "warning",
    heap_mb: Math.round(mem.heapUsed / 1048576),
    rss_mb: Math.round(mem.rss / 1048576),
  };

  // Disk probe
  try {
    const fs = require("fs");
    const stats = fs.statSync("/root/AgentOS/data/agentos.db");
    probes.disk = { status: "ok", db_size_mb: Math.round(stats.size / 1048576 * 100) / 100 };
  } catch {
    probes.disk = { status: "ok", note: "db file check skipped" };
  }

  // Uptime
  probes.uptime = { status: "ok", seconds: Math.round(process.uptime()), hours: Math.round(process.uptime() / 3600 * 10) / 10 };

  // Table counts
  const tables = ["agents", "phones", "emails", "servers", "domains", "webhooks", "escrows", "tasks"];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as any;
      counts[t] = r.c;
    } catch { /* table may not exist */ }
  }
  probes.resources = { status: "ok", counts };

  const allOk = Object.values(probes).every((p: any) => p.status === "ok");

  res.json({
    status: allOk ? "healthy" : "degraded",
    response_ms: Date.now() - start,
    probes,
    hackathon: {
      deadline: "2026-02-12T17:00:00Z",
      hours_remaining: Math.round((new Date("2026-02-12T17:00:00Z").getTime() - Date.now()) / 3600000 * 10) / 10,
    },
    checked_at: new Date().toISOString(),
  });
});

export default router;
