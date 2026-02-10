import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

function safeCount(db: any, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
    return row?.count || 0;
  } catch { return 0; }
}

router.get("/final-hours", (_req: Request, res: Response) => {
  // db already imported
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const msLeft = Math.max(0, deadline.getTime() - now.getTime());
  const hoursLeft = msLeft / 3600000;
  const minutesLeft = msLeft / 60000;

  let urgency = "EXPIRED";
  let message = "Hackathon is over. Thanks for building with us.";
  if (hoursLeft > 24) { urgency = "NORMAL"; message = "Keep building. Plenty of time."; }
  else if (hoursLeft > 12) { urgency = "MEDIUM"; message = "Final day approaching. Focus on polish."; }
  else if (hoursLeft > 6) { urgency = "HIGH"; message = "Last stretch. Ship what you have."; }
  else if (hoursLeft > 0) { urgency = "CRITICAL"; message = "Final hours. Make every commit count."; }

  res.json({
    project: "AgentOS",
    version: "v2.0.0",
    deadline: deadline.toISOString(),
    remaining: {
      hours: Math.round(hoursLeft * 10) / 10,
      minutes: Math.round(minutesLeft),
      human: hoursLeft > 0 ? `${Math.floor(hoursLeft)}h ${Math.round((hoursLeft % 1) * 60)}m` : "EXPIRED"
    },
    urgency,
    message,
    live_db: {
      agents: safeCount(db, "agents"),
      phones: safeCount(db, "phones"),
      emails: safeCount(db, "emails"),
      servers: safeCount(db, "servers"),
      webhooks: safeCount(db, "webhooks"),
      invoices: safeCount(db, "invoices"),
      logs: safeCount(db, "logs")
    },
    build_stats: {
      endpoints: "204+",
      route_files: 180,
      forum_comments: "790+",
      versions_shipped: "50+",
      days_building: 11
    },
    try_now: [
      "curl http://77.42.89.233:3001/api/hackathon",
      "curl http://77.42.89.233:3001/api/system-health",
      "curl http://77.42.89.233:3001/api/for-judges"
    ],
    links: {
      docs: "http://77.42.89.233:3001/docs",
      github: "https://github.com/0xArtex/AgentOS",
      colosseum: "https://agents.colosseum.com/projects/432"
    }
  });
});

export default router;
