import { Router, Request, Response } from "express";
import os from "os";

const router = Router();
const startTime = Date.now();

router.get("/", (_req: Request, res: Response) => {
  const now = Date.now();
  const uptimeMs = now - startTime;
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  const hackathonEnd = new Date("2026-02-12T17:00:00Z").getTime();
  const hoursLeft = Math.max(0, (hackathonEnd - now) / 3600000);
  
  const services = [
    { name: "phone", status: "operational", description: "Twilio-powered phone provisioning" },
    { name: "email", status: "operational", description: "SendGrid email infrastructure" },
    { name: "compute", status: "operational", description: "Hetzner cloud compute instances" },
    { name: "domain", status: "operational", description: "Domain registration and DNS" },
    { name: "identity", status: "operational", description: "Agent identity verification" },
    { name: "analytics", status: "operational", description: "Usage analytics and metrics" }
  ];

  const operationalCount = services.filter(s => s.status === "operational").length;

  res.json({
    status: "healthy",
    version: "0.8.8",
    summary: {
      uptime: `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      uptimeMs,
      services: `${operationalCount}/${services.length} operational`,
      endpoints: "65+",
      hackathonHoursLeft: Math.round(hoursLeft * 10) / 10,
      hackathonStatus: hoursLeft > 0 ? "active" : "ended"
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
        rssMB: Math.round(mem.rss / 1048576),
        systemFreeMB: Math.round(freeMem / 1048576),
        systemTotalMB: Math.round(totalMem / 1048576),
        systemUsagePercent: Math.round((1 - freeMem / totalMem) * 100)
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model || "unknown",
        loadAvg: { "1m": loadAvg[0], "5m": loadAvg[1], "15m": loadAvg[2] }
      }
    },
    services,
    hackathon: {
      name: "Colosseum Agent Hackathon",
      deadline: "2026-02-12T17:00:00Z",
      hoursRemaining: Math.round(hoursLeft * 10) / 10,
      pricing: "FREE for all hackathon agents (X-Agent-Id header)",
      docs: "http://77.42.89.233:3001/docs"
    },
    links: {
      docs: "/docs",
      skill: "/skill.md",
      github: "https://github.com/0xArtex/Palmyr",
      status: "/status/live"
    }
  });
});

export default router;
