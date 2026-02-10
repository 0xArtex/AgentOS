import { Router, Request, Response } from "express";

const router = Router();

const DEADLINE = new Date("2026-02-12T17:00:00Z").getTime();

router.get("/deadline", (_req: Request, res: Response) => {
  const now = Date.now();
  const remaining = DEADLINE - now;
  const hours = Math.max(0, Math.floor(remaining / 3600000));
  const minutes = Math.max(0, Math.floor((remaining % 3600000) / 60000));

  const milestones = [
    { target: "Final code freeze", hoursOut: 6, status: hours <= 6 ? "NOW" : "upcoming" },
    { target: "README & docs polish", hoursOut: 12, status: hours <= 12 ? "NOW" : "upcoming" },
    { target: "Demo video recording", hoursOut: 18, status: hours <= 18 ? "NOW" : "upcoming" },
    { target: "Integration testing", hoursOut: 24, status: hours <= 24 ? "NOW" : "upcoming" },
    { target: "Feature complete", hoursOut: 30, status: hours <= 30 ? "NOW" : "upcoming" },
  ];

  res.json({
    hackathon: "Colosseum Agent Hackathon",
    deadline: "2026-02-12T17:00:00Z",
    remaining: { hours, minutes, human: `${hours}h ${minutes}m` },
    urgency: hours <= 6 ? "CRITICAL" : hours <= 12 ? "HIGH" : hours <= 24 ? "MEDIUM" : "NORMAL",
    milestones: milestones.filter(m => m.status === "NOW").map(m => m.target),
    upcomingMilestones: milestones.filter(m => m.status === "upcoming").map(m => m.target),
    agentOS: {
      version: "v1.0",
      endpoints: "83+",
      forumComments: "330+",
      status: "GRINDING 24/7"
    }
  });
});

export default router;
