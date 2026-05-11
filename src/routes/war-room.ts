import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/war-room", async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const deadline = new Date("2026-02-12T17:00:00Z");
    const hoursLeft = Math.max(0, (deadline.getTime() - now.getTime()) / 3600000);

    const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0;
    const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any)?.c || 0;
    const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any)?.c || 0;
    const servers = (db.prepare("SELECT COUNT(*) as c FROM servers").get() as any)?.c || 0;
    const domains = (db.prepare("SELECT COUNT(*) as c FROM domains").get() as any)?.c || 0;
    const apiKeys = (db.prepare("SELECT COUNT(*) as c FROM api_keys").get() as any)?.c || 0;
    const requests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any)?.c || 0;

    const oneDayAgo = new Date(now.getTime() - 86400000).toISOString();
    const recentRequests = (db.prepare("SELECT COUNT(*) as c FROM request_log WHERE created_at > ?").get(oneDayAgo) as any)?.c || 0;
    const recentAgents = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE created_at > ?").get(oneDayAgo) as any)?.c || 0;

    res.json({
      war_room: "Palmyr Hackathon Command Center",
      countdown: {
        deadline: deadline.toISOString(),
        hours_remaining: Math.round(hoursLeft * 10) / 10,
        status: hoursLeft > 24 ? "grinding" : hoursLeft > 6 ? "final_push" : "endgame"
      },
      platform_stats: { agents, phones, emails, servers, domains, api_keys: apiKeys, api_requests: requests, endpoints_live: "185+" },
      last_24h: { new_agents: recentAgents, api_requests: recentRequests },
      system_health: { memory_mb: Math.round(process.memoryUsage().heapUsed / 1048576), uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10 },
      key_links: { docs: "http://77.42.89.233:3001/docs", dashboard: "http://77.42.89.233:3001/dashboard", demo_script: "http://77.42.89.233:3001/api/demo-script", for_judges: "http://77.42.89.233:3001/api/for-judges" },
      forum_presence: { total_comments: "665+", threads_engaged: "80+" }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
