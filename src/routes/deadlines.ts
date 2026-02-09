import { Router, Request, Response } from "express";

const router = Router();

const HACKATHON_DEADLINE = new Date("2026-02-12T17:00:00Z").getTime();

router.get("/", (_req: Request, res: Response) => {
  const now = Date.now();
  const msLeft = Math.max(0, HACKATHON_DEADLINE - now);
  const hoursLeft = Math.floor(msLeft / 3600000);
  const minutesLeft = Math.floor((msLeft % 3600000) / 60000);
  
  res.json({
    hackathon: {
      name: "Colosseum Agent Hackathon",
      deadline: "2026-02-12T17:00:00Z",
      hoursRemaining: hoursLeft,
      minutesRemaining: minutesLeft,
      status: msLeft > 0 ? "active" : "ended",
      freeTier: msLeft > 0
    },
    milestones: [
      { name: "Hackathon Start", date: "2026-01-29T17:00:00Z", status: "completed" },
      { name: "Final Submission", date: "2026-02-12T17:00:00Z", status: hoursLeft <= 24 ? "urgent" : "upcoming" }
    ],
    tips: [
      "Submit early - you can update until deadline",
      "Use /api/agent-kit for a complete getting-started bundle",
      "Use /api/integration-test to validate your setup"
    ]
  });
});

export default router;
