import { Router } from "express";
import { db } from "../db";

const router = Router();

const startTime = Date.now();

/**
 * @swagger
 * /ping:
 *   get:
 *     summary: Real-time health ping with latency metrics
 *     description: Returns live system metrics — uptime, DB latency, memory usage, request throughput. Useful for monitoring and judge evaluation.
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Live health metrics
 */
router.get("/", (_req, res) => {
  const now = Date.now();
  
  // Measure DB latency
  const dbStart = performance.now();
  let dbOk = true;
  let dbRows = 0;
  try {
    const r = db.prepare("SELECT COUNT(*) as c FROM agents").get() as any;
    dbRows = r.c;
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Math.round((performance.now() - dbStart) * 100) / 100;

  // Memory usage
  const mem = process.memoryUsage();
  
  // Request count last hour
  let requestsLastHour = 0;
  try {
    const oneHourAgo = new Date(now - 3600000).toISOString();
    requestsLastHour = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE timestamp > ?").get(oneHourAgo) as any).c;
  } catch {}

  // Unique agents last hour
  let activeAgents = 0;
  try {
    const oneHourAgo = new Date(now - 3600000).toISOString();
    activeAgents = (db.prepare("SELECT COUNT(DISTINCT agent_id) as c FROM request_log WHERE agent_id IS NOT NULL AND timestamp > ?").get(oneHourAgo) as any).c;
  } catch {}

  const uptimeSeconds = Math.floor((now - startTime) / 1000);
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, Math.round((deadline - now) / 3600000 * 10) / 10);

  res.json({
    status: "alive",
    timestamp: new Date(now).toISOString(),
    uptime: {
      seconds: uptimeSeconds,
      human: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`
    },
    database: {
      ok: dbOk,
      latencyMs: dbLatencyMs,
      agents: dbRows
    },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      rssMB: Math.round(mem.rss / 1048576)
    },
    throughput: {
      requestsLastHour,
      activeAgentsLastHour: activeAgents
    },
    hackathon: {
      hoursRemaining: hoursLeft,
      deadline: "2026-02-12T17:00:00Z",
      mode: hoursLeft > 0 ? "FREE — all endpoints unlocked" : "hackathon ended"
    },
    version: "v1.1.8"
  });
});

export default router;
