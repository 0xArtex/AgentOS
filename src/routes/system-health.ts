import { Router } from "express";
import { execSync } from "child_process";

const router = Router();
const startTime = Date.now();

function safeExec(cmd: string): string {
  try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch { return "unavailable"; }
}

/**
 * @swagger
 * /system-health:
 *   get:
 *     summary: Live system health metrics
 *     description: Real-time server metrics — CPU, memory, disk, network, process info. Proves this is live infrastructure, not a mock.
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Live system metrics
 */
router.get("/", (_req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const loadAvg = safeExec("cat /proc/loadavg").split(" ");
  const diskUsage = safeExec("df -h / | tail -1").split(/\s+/);
  const totalMem = safeExec("free -m | grep Mem | awk '{print $2}'");
  const usedMem = safeExec("free -m | grep Mem | awk '{print $3}'");
  const cpuCount = safeExec("nproc");
  const osUptime = safeExec("uptime -p");
  const nodeVersion = process.version;
  const connections = safeExec("ss -tun | grep ESTAB | wc -l");

  res.json({
    status: "operational",
    server: {
      os_uptime: osUptime,
      cpu_cores: parseInt(cpuCount) || 0,
      load_average: {
        "1m": parseFloat(loadAvg[0]) || 0,
        "5m": parseFloat(loadAvg[1]) || 0,
        "15m": parseFloat(loadAvg[2]) || 0,
      },
      memory: {
        total_mb: parseInt(totalMem) || 0,
        used_mb: parseInt(usedMem) || 0,
        usage_pct: totalMem && usedMem ? Math.round((parseInt(usedMem) / parseInt(totalMem)) * 100) : 0,
      },
      disk: {
        total: diskUsage[1] || "unknown",
        used: diskUsage[2] || "unknown",
        available: diskUsage[3] || "unknown",
        usage_pct: diskUsage[4] || "unknown",
      },
      active_connections: parseInt(connections) || 0,
    },
    process: {
      node_version: nodeVersion,
      uptime_seconds: Math.round(uptime),
      uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
      memory_heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      pid: process.pid,
    },
    timestamp: new Date().toISOString(),
    note: "These are live metrics from the Palmyr production server. Not mocked.",
  });
});

export default router;
