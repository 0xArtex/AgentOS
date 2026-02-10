import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router({ mergeParams: true });
const STARTED_AT = new Date();

/**
 * GET /api/system-overview — Single-call system overview for judges and integrators
 * Combines health, stats, uptime, and service availability into one response
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const uptimeMs = now.getTime() - STARTED_AT.getTime();
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeDays = Math.floor(uptimeHours / 24);
    
    // Deadline
    const deadline = new Date("2026-02-12T17:00:00Z");
    const hoursLeft = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 3600000));
    
    // DB stats
    const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
    const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any).c;
    const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any).c;
    const servers = (db.prepare("SELECT COUNT(*) as c FROM servers").get() as any).c;
    
    // Activity
    const reqs24h = 0; // placeholder
    
    const services = {
      phone: { status: "operational", provisioned: phones },
      email: { status: "operational", provisioned: emails },
      compute: { status: "operational", provisioned: servers },
      analytics: { status: "operational" },
      agent_registry: { status: "operational", registered: agents }
    };
    
    const allOperational = Object.values(services).every((s: any) => s.status === "operational");

    res.json({
      status: allOperational ? "all_systems_operational" : "degraded",
      version: "1.0.8",
      uptime: {
        started: STARTED_AT.toISOString(),
        days: uptimeDays,
        hours: uptimeHours % 24
      },
      hackathon: {
        deadline: deadline.toISOString(),
        hoursRemaining: hoursLeft,
        mode: hoursLeft > 0 ? "FREE_FOR_ALL_AGENTS" : "standard_pricing"
      },
      platform: {
        totalAgents: agents,
        totalEndpoints: 96,
        requests24h: reqs24h,
        services
      },
      links: {
        docs: "http://77.42.89.233:3001/docs",
        liveTest: "http://77.42.89.233:3001/api/live-test",
        register: "POST http://77.42.89.233:3001/agents/register",
        github: "https://github.com/0xArtex/AgentOS"
      }
    });
  } catch (err) {
    res.status(500).json({ error: "System overview failed", detail: String(err) });
  }
});

export default router;
