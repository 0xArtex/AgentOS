import { Router } from "express";
import { getHealth, getVersion } from "../utils/health";
import os from "os";

const router = Router();
const startTime = Date.now();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Lightweight health check
 *     description: Returns service health for uptime monitors. Fast, no DB queries.
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded
 */
router.get("/", (_req, res) => {
  const health = getHealth();
  const version = getVersion();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();

  const status = {
    status: "healthy",
    version,
    uptime: {
      seconds: uptimeSeconds,
      human: formatUptime(uptimeSeconds),
    },
    memory: {
      rss_mb: Math.round(memUsage.rss / 1048576),
      heap_used_mb: Math.round(memUsage.heapUsed / 1048576),
      heap_total_mb: Math.round(memUsage.heapTotal / 1048576),
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      load_avg: os.loadavg().map(l => Math.round(l * 100) / 100),
      free_mem_mb: Math.round(os.freemem() / 1048576),
      total_mem_mb: Math.round(os.totalmem() / 1048576),
    },
    timestamp: new Date().toISOString(),
  };

  res.json(status);
});

/**
 * @swagger
 * /health/ping:
 *   get:
 *     summary: Ultra-lightweight ping
 *     description: Returns "pong" — for the fastest possible health check
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: pong
 */
router.get("/ping", (_req, res) => {
  res.send("pong");
});

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default router;
