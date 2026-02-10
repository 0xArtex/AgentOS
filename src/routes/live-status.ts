import { Router, Request, Response } from "express";
import os from "os";
import { db } from "../db";

const router = Router({ mergeParams: true });

router.get("/", (_req: Request, res: Response) => {
  const now = Date.now();
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const msLeft = Math.max(0, deadline - now);
  const hoursLeft = Math.round(msLeft / 3600000 * 10) / 10;
  const daysLeft = Math.round(msLeft / 86400000 * 10) / 10;

  const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  const requests24h = (db.prepare('SELECT COUNT(*) as c FROM request_log WHERE created_at > datetime(\'now\', \'-24 hours\')').get() as any).c;
  const requestsTotal = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any).c;

  const uptimeSec = process.uptime();
  const uptimeH = Math.floor(uptimeSec / 3600);
  const uptimeM = Math.floor((uptimeSec % 3600) / 60);

  res.json({
    status: "operational",
    version: "v1.2.5",
    uptime: uptimeH + "h " + uptimeM + "m",
    uptimeSeconds: Math.round(uptimeSec),
    system: {
      cpus: os.cpus().length,
      memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      memoryTotalMb: Math.round(os.totalmem() / 1048576),
      loadAvg1m: Math.round(os.loadavg()[0] * 100) / 100,
    },
    database: {
      registeredAgents: agents,
      totalApiRequests: requestsTotal,
      requestsLast24h: requests24h,
    },
    hackathon: {
      deadline: "2026-02-12T17:00:00Z",
      daysRemaining: daysLeft,
      hoursRemaining: hoursLeft,
      freeAccess: msLeft > 0,
    },
    endpoints: 111,
    services: ["phone", "email", "compute", "domains", "storage", "webhooks", "invoicing", "analytics"],
  });
});

export default router;
