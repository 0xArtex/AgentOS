import { Router } from "express";
import os from "os";
import fs from "fs";

const router = Router();
const startTime = Date.now();

/**
 * @swagger
 * /system-metrics:
 *   get:
 *     summary: Real-time system metrics
 *     description: Live OS-level metrics — CPU, memory, disk, network, process stats. Useful for monitoring agents to verify platform health before provisioning.
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: System metrics
 */
router.get("/", (_req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // Disk usage (best effort)
  let disk = { total: 0, free: 0, used: 0, usedPercent: 0 };
  try {
    const stats = fs.statfsSync("/");
    disk.total = stats.bsize * stats.blocks;
    disk.free = stats.bsize * stats.bavail;
    disk.used = disk.total - disk.free;
    disk.usedPercent = Math.round((disk.used / disk.total) * 100);
  } catch {}

  // CPU avg utilization from load average
  const cpuCount = cpus.length;
  const cpuModel = cpus[0]?.model || "unknown";

  // Process stats
  const proc = process.memoryUsage();

  res.json({
    timestamp: new Date().toISOString(),
    platform: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
      process_uptime_hours: Math.round((Date.now() - startTime) / 3600000 * 10) / 10,
    },
    cpu: {
      model: cpuModel,
      cores: cpuCount,
      load_1m: loadAvg[0],
      load_5m: loadAvg[1],
      load_15m: loadAvg[2],
      utilization_pct: Math.round((loadAvg[0] / cpuCount) * 100),
    },
    memory: {
      total_gb: Math.round(totalMem / 1073741824 * 10) / 10,
      used_gb: Math.round(usedMem / 1073741824 * 10) / 10,
      free_gb: Math.round(freeMem / 1073741824 * 10) / 10,
      used_pct: Math.round((usedMem / totalMem) * 100),
    },
    disk: {
      total_gb: Math.round(disk.total / 1073741824 * 10) / 10,
      used_gb: Math.round(disk.used / 1073741824 * 10) / 10,
      free_gb: Math.round(disk.free / 1073741824 * 10) / 10,
      used_pct: disk.usedPercent,
    },
    process: {
      rss_mb: Math.round(proc.rss / 1048576),
      heap_used_mb: Math.round(proc.heapUsed / 1048576),
      heap_total_mb: Math.round(proc.heapTotal / 1048576),
      external_mb: Math.round(proc.external / 1048576),
    },
    verdict: loadAvg[0] / cpuCount < 0.8 && (usedMem / totalMem) < 0.9
      ? "✅ Healthy — ready to provision"
      : "⚠️ Under load — provisioning may be slower",
  });
});

export default router;
