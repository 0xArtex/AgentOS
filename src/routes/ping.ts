import { Router, Request, Response } from "express";

const router = Router();
const startTime = Date.now();

router.get("/", (_req: Request, res: Response) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeHours = Math.floor(uptimeMs / 3600000);
  const uptimeDays = Math.floor(uptimeHours / 24);
  
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: {
      ms: uptimeMs,
      hours: uptimeHours,
      days: uptimeDays,
      human: uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours % 24}h` : `${uptimeHours}h`
    },
    version: "v2.2.0",
    region: "eu-central",
    latency: "< 50ms"
  });
});

export default router;
