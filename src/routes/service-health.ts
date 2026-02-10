import { Router, Request, Response } from "express";
import os from "os";
import fs from "fs";
import path from "path";

const router = Router();

// Real health check - tests actual subsystems
router.get("/service-health", async (req: Request, res: Response) => {
  const start = Date.now();
  const checks: Record<string, any> = {};

  // DB check
  try {
    const dbPath = path.join(__dirname, "../../data/agents.json");
    const stat = fs.statSync(dbPath);
    checks.database = { status: "healthy", size_bytes: stat.size, last_modified: stat.mtime };
  } catch {
    checks.database = { status: "degraded", error: "agents.json not accessible" };
  }

  // Disk check
  try {
    const tmpFile = path.join(os.tmpdir(), `health-${Date.now()}`);
    fs.writeFileSync(tmpFile, "ok");
    fs.unlinkSync(tmpFile);
    checks.disk_write = { status: "healthy" };
  } catch {
    checks.disk_write = { status: "unhealthy", error: "Cannot write to disk" };
  }

  // Memory check
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const memUsage = process.memoryUsage();
  checks.memory = {
    status: freeMem / totalMem > 0.1 ? "healthy" : "warning",
    system_free_mb: Math.round(freeMem / 1024 / 1024),
    system_total_mb: Math.round(totalMem / 1024 / 1024),
    process_heap_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    process_rss_mb: Math.round(memUsage.rss / 1024 / 1024)
  };

  // CPU check
  const load = os.loadavg();
  const cpus = os.cpus().length;
  checks.cpu = {
    status: load[0] / cpus < 0.8 ? "healthy" : "warning",
    load_1m: load[0].toFixed(2),
    load_5m: load[1].toFixed(2),
    cores: cpus
  };

  // Uptime
  checks.uptime = {
    system_hours: Math.round(os.uptime() / 3600),
    process_hours: Math.round(process.uptime() / 3600)
  };

  const allHealthy = Object.values(checks).every((c: any) => c.status !== "unhealthy");
  const latency = Date.now() - start;

  res.json({
    status: allHealthy ? "operational" : "degraded",
    response_time_ms: latency,
    timestamp: new Date().toISOString(),
    version: "v1.0.0",
    checks,
    hackathon: {
      deadline: "2026-02-12T17:00:00Z",
      hours_remaining: Math.max(0, Math.round((new Date("2026-02-12T17:00:00Z").getTime() - Date.now()) / 3600000)),
      free_tier: true
    }
  });
});

export default router;
