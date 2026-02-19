import { Router, Request, Response } from "express";
import os from "os";

const router = Router();

router.get("/api/platform-health", (_req: Request, res: Response) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const sysMem = { total: os.totalmem(), free: os.freemem() };
  const load = os.loadavg();

  res.json({
    status: "operational",
    timestamp: new Date().toISOString(),
    process: {
      uptimeSeconds: Math.round(uptime),
      uptimeHuman: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memoryMB: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
        heapTotal: Math.round(mem.heapTotal / 1048576),
        external: Math.round(mem.external / 1048576),
      },
      pid: process.pid,
      nodeVersion: process.version,
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAvg: { "1m": load[0].toFixed(2), "5m": load[1].toFixed(2), "15m": load[2].toFixed(2) },
      memoryMB: {
        total: Math.round(sysMem.total / 1048576),
        free: Math.round(sysMem.free / 1048576),
        usedPercent: ((1 - sysMem.free / sysMem.total) * 100).toFixed(1) + "%",
      },
      hostname: os.hostname(),
    },
    services: {
      api: "up",
      database: "sqlite",
      x402: "enabled",
    },
  });
});

export default router;
