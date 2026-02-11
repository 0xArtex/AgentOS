import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/api/hours-left", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z").getTime();
  const now = Date.now();
  const msLeft = Math.max(0, deadline - now);
  const hoursLeft = Math.round(msLeft / 3600000 * 10) / 10;
  
  const agents = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any)?.c || 0;
  const requests = (db.prepare("SELECT COUNT(*) as c FROM request_log").get() as any)?.c || 0;
  const phones = (db.prepare("SELECT COUNT(*) as c FROM phone_numbers").get() as any)?.c || 0;
  const emails = (db.prepare("SELECT COUNT(*) as c FROM email_inboxes").get() as any)?.c || 0;
  
  const urgency = hoursLeft <= 0 ? "SUBMITTED" : hoursLeft <= 2 ? "FINAL_MINUTES" : hoursLeft <= 6 ? "CRUNCH_TIME" : hoursLeft <= 12 ? "HEADS_DOWN" : "BUILDING";
  
  res.json({
    project: "AgentOS",
    hoursRemaining: hoursLeft,
    urgency,
    expired: msLeft <= 0,
    liveStats: { agents, requests, phones, emails },
    message: hoursLeft <= 0 ? "Hackathon complete!" : `${hoursLeft}h until deadline. Ship it.`,
    links: {
      api: "https://agntos.dev",
      docs: "https://agntos.dev/docs",
      dashboard: "http://77.42.89.233:3001/dashboard",
      github: "https://github.com/0xArtex/AgentOS"
    }
  });
});

export default router;
