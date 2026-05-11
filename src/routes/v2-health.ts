import { Router, Request, Response } from "express";

const router = Router();

// Enhanced health check with detailed system metrics
router.get("/api/v2/health", async (req: Request, res: Response) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const startTime = new Date(Date.now() - uptime * 1000).toISOString();
  
  res.json({
    status: "healthy",
    version: "2.1.0",
    uptime: {
      seconds: Math.floor(uptime),
      human: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      since: startTime
    },
    memory: {
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      external: `${Math.round(mem.external / 1024 / 1024)}MB`
    },
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    postHackathon: {
      status: "FREE for all builders",
      message: "Palmyr remains free through March 2026 for all Colosseum hackathon participants",
      docs: "https://palmyr.ai/docs"
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
