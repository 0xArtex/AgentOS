import { Router } from "express";

const router = Router();
const BOOT_TIME = Date.now();

/**
 * @swagger
 * /api/uptime:
 *   get:
 *     summary: Real-time uptime and system metrics
 *     description: Live server uptime, memory usage, CPU load, and request stats
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Uptime metrics
 */
router.get("/", (_req, res) => {
  const now = Date.now();
  const uptimeMs = now - BOOT_TIME;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const mem = process.memoryUsage();
  const os = require("os");

  res.json({
    status: "operational",
    uptime: {
      human: `${days}d ${hours}h ${minutes}m`,
      seconds: uptimeSec,
      since: new Date(BOOT_TIME).toISOString(),
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
      totalMemoryMB: Math.round(os.totalmem() / 1048576),
      freeMemoryMB: Math.round(os.freemem() / 1048576),
    },
    process: {
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      rssMB: Math.round(mem.rss / 1048576),
      pid: process.pid,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
