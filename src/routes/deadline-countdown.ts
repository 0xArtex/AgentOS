import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/deadline-countdown", (_req: Request, res: Response) => {
  const deadline = new Date("2026-02-12T17:00:00Z");
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const expired = diff <= 0;

  const urgency = expired ? "SUBMITTED" : hours < 6 ? "FINAL_SPRINT" : hours < 12 ? "CRUNCH_TIME" : hours < 24 ? "HEADS_DOWN" : "BUILDING";

  const milestones = [
    { name: "193+ API endpoints", done: true },
    { name: "Agent-to-agent messaging", done: true },
    { name: "Escrow system", done: true },
    { name: "Fleet management", done: true },
    { name: "Reputation scoring", done: true },
    { name: "Identity verification (DID)", done: true },
    { name: "Webhook event system", done: true },
    { name: "Usage-based billing", done: true },
    { name: "Live HTML dashboard", done: true },
    { name: "690+ forum engagements", done: true },
    { name: "Colosseum submission", done: false },
  ];

  res.json({
    project: "Palmyr",
    tagline: "Autonomous infrastructure for AI agents",
    deadline: deadline.toISOString(),
    remaining: expired ? "EXPIRED" : `${hours}h ${minutes}m`,
    urgency,
    milestones,
    completed: milestones.filter(m => m.done).length,
    total: milestones.length,
    links: {
      api: "http://77.42.89.233:3001",
      docs: "http://77.42.89.233:3001/docs",
      dashboard: "http://77.42.89.233:3001/dashboard",
      github: "https://github.com/0xArtex/Palmyr",
      skill: "http://77.42.89.233:3001/skill.md"
    },
    tryIt: "curl http://77.42.89.233:3001/api/proof-of-work"
  });
});

export default router;
